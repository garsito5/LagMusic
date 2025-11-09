// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, PermissionsBitField, EmbedBuilder } = require('discord.js');
const express = require('express');
const { Player, QueryType, QueueRepeatMode } = require('discord-player');

// ✅ Usa variables de entorno directamente, sin exigir archivo .env
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

// Muestra advertencia si no está definido, pero no detiene el proceso (Render lo inyecta después)
if (!TOKEN) {
  console.warn('⚠️ TOKEN no detectado localmente. Asegúrate de definirlo en las variables de entorno de Render.');
}

/**
 * --- CONFIGURACIÓN ---
 */
const HELP_CHANNEL_IDS = [
  '1422809286417059850',
  '1222966360263626865'
];
const HELP_COLOR = 0x8A2BE2; // púrpura (#8A2BE2)

/**
 * --- Cliente Discord y Player ---
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const player = new Player(client, {
  ytdlOptions: {
    quality: 'highestaudio',
    highWaterMark: 1 << 25
  }
});

/**
 * --- Datos en memoria ---
 */
// mapa channelId -> creatorUserId (se establece la primera vez que alguien usa /play en ese canal)
const voiceChannelCreators = new Map();
// mapa channelId -> Set(userId) de permisos extra (pueden usar skip/pause/resume/stop)
const channelPermittedUsers = new Map();
// mapa channelId -> Set(userId) de votoskips activos (se reinicia por canción)
const voteSkips = new Map();

/**
 * --- Helpers ---
 */
function ensurePermSet(channelId) {
  if (!channelPermittedUsers.has(channelId)) channelPermittedUsers.set(channelId, new Set());
}
function ensureVoteSet(channelId) {
  if (!voteSkips.has(channelId)) voteSkips.set(channelId, new Set());
}

function isCreatorOrPermitted(member, voiceChannelId) {
  if (!member) return false;
  const creator = voiceChannelCreators.get(voiceChannelId);
  if (creator && member.id === creator) return true;
  const set = channelPermittedUsers.get(voiceChannelId);
  if (set && set.has(member.id)) return true;
  return false;
}

/**
 * --- Comandos (definidos para autoregistro) ---
 */
const commands = [
  {
    name: 'play',
    description: 'Reproduce una canción o la añade a la cola',
    options: [
      { name: 'query', type: 3, description: 'Nombre o URL de la canción', required: true }
    ]
  },
  {
    name: 'playlist',
    description: 'Reproduce una playlist (busca por plataforma + nombre)',
    options: [
      { name: 'platform', type: 3, description: 'Plataforma (youtube, spotify, soundcloud, ytmusic, etc.)', required: true },
      { name: 'name', type: 3, description: 'Nombre o URL de la playlist', required: true }
    ]
  },
  { name: 'skip', description: 'Salta la canción actual (si eres creador o tienes permiso). Si no, usar /vote_skip' },
  { name: 'vote_skip', description: 'Inicia/participa en votación para saltar la canción actual' },
  { name: 'pause', description: 'Pausa la reproducción' },
  { name: 'resume', description: 'Reanuda la reproducción' },
  { name: 'bucle', description: 'Activa el bucle para la canción actual' },
  { name: 'stopbucle', description: 'Desactiva el bucle' },
  { name: 'random', description: 'Activa/desactiva reproducción aleatoria (shuffle) de la cola' },
  {
    name: 'add_permiss',
    description: 'El creador puede dar permisos de control a otro usuario',
    options: [{ name: 'usuario', type: 6, description: 'Usuario a quien dar permisos', required: true }]
  },
  { name: 'clear', description: 'El creador borra la cola (excepto la canción que suena)' },
  {
    name: 'karaoke',
    description: 'Busca y reproduce la versión karaoke/instrumental de la canción',
    options: [{ name: 'query', type: 3, description: 'Nombre de la canción', required: true }]
  },
  {
    name: 'help',
    description: 'Muestra la lista de comandos (solo en canales de voz o canales específicos)'
  }
];

/**
 * --- Auto registro de comandos por guild (rápido y efectivo) ---
 */
client.once('ready', async () => {
  console.log(`Conectado como ${client.user.tag}`);
  // Registrar comandos en cada guild donde el bot esté (inmediato)
  const guilds = client.guilds.cache.map(g => g.id);
  for (const guildId of guilds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Comandos registrados en guild ${guildId}`);
    } catch (err) {
      console.warn('No se pudieron registrar comandos en guild', guildId, err?.message ?? err);
    }
  }

  // Express ping (para plataformas como Render/Heroku)
  const app = express();
  app.get('/', (req, res) => res.send('Sirgio Music Bot is alive'));
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Express corriendo en puerto ${port}`));
});

/**
 * --- Eventos del player (feedback opcional) ---
 */
player.on('error', (queue, error) => {
  console.error('Player Error', error);
});
player.on('connectionError', (queue, error) => {
  console.error('Connection Error', error);
});

/**
 * Cuando una canción empieza, limpiamos votos y mostramos un embed básico
 */
player.on('trackStart', (queue, track) => {
  try {
    voteSkips.set(queue.metadata.voiceChannel.id, new Set());
    const embed = new EmbedBuilder()
      .setTitle('Reproduciendo ahora')
      .setDescription(`[${track.title}](${track.url})`)
      .addFields(
        { name: 'Duración', value: track.duration, inline: true },
        { name: 'Solicitado por', value: `${track.requestedBy?.tag ?? 'Desconocido'}`, inline: true }
      )
      .setTimestamp();
    queue.metadata.textChannel.send({ embeds: [embed] }).catch(() => {});
  } catch (e) { /* ignore */ }
});

/**
 * Cuando la cola termina, desconectamos y limpiamos permisos/votos/creador
 */
player.on('queueEnd', (queue) => {
  try {
    const vcId = queue.metadata.voiceChannel.id;
    voiceChannelCreators.delete(vcId);
    channelPermittedUsers.delete(vcId);
    voteSkips.delete(vcId);
    queue.metadata.textChannel.send('La cola ha terminado. Me desconecto.').catch(() => {});
  } catch (e) {}
});

/**
 * --- Manejador de interacciones (slash commands) ---
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;
  const guild = interaction.guild;

  // helper: require that the user is in a voice channel for most commands
  const requireVoice = (reply = true) => {
    if (!member || !member.voice || !member.voice.channel) {
      if (reply) interaction.reply({ content: 'Tienes que estar en un canal de voz para usar este comando.', ephemeral: true });
      return false;
    }
    return true;
  };

  try {
    switch (interaction.commandName) {
      case 'play': {
        if (!requireVoice()) return;
        const query = interaction.options.getString('query', true);
        const voiceChannel = member.voice.channel;

        // registrar creador del canal si no existe
        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        await interaction.deferReply();

        // metadata para que player pueda mandar mensajes útiles y saber el voiceChannel
        const queue = player.createQueue(guild, {
          metadata: {
            textChannel: interaction.channel,
            voiceChannel: voiceChannel
          }
        });

        if (!queue.connection) await queue.connect(voiceChannel).catch(err => {
          console.error(err);
          queue.destroy();
          return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
        });

        // buscar y reproducir
        const searchResult = await player.search(query, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!searchResult || !searchResult.tracks.length) {
          return interaction.editReply({ content: `No se encontró la canción: ${query}` });
        }

        const track = searchResult.tracks[0];
        await queue.addTrack(track);
        if (!queue.playing) await queue.play();

        const embed = new EmbedBuilder()
          .setTitle('Añadido a la cola')
          .setDescription(`[${track.title}](${track.url})`)
          .addFields(
            { name: 'Duración', value: track.duration ?? 'Desconocida', inline: true },
            { name: 'Posición en cola', value: `${queue.tracks.indexOf(track) + 1}`, inline: true }
          );
        return interaction.editReply({ embeds: [embed] });
      }

      case 'playlist': {
        if (!requireVoice()) return;
        const platform = interaction.options.getString('platform', true);
        const name = interaction.options.getString('name', true);
        const voiceChannel = member.voice.channel;

        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        await interaction.deferReply();

        const queue = player.createQueue(guild, {
          metadata: {
            textChannel: interaction.channel,
            voiceChannel: voiceChannel
          }
        });

        if (!queue.connection) await queue.connect(voiceChannel).catch(err => {
          console.error(err);
          queue.destroy();
          return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
        });

        // Buscar la playlist en forma general (dejamos al motor buscar)
        const searchQuery = `${platform} playlist ${name}`;
        const result = await player.search(searchQuery, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!result || !result.tracks.length) {
          return interaction.editReply({ content: `No encontré la playlist: ${platform} ${name}` });
        }

        // Si es un playlist, result.playlist puede existir; añadimos todos los tracks
        const tracksToAdd = result.playlist ? result.playlist.tracks : result.tracks;
        await queue.addTracks(tracksToAdd);
        if (!queue.playing) await queue.play();

        const embed = new EmbedBuilder()
          .setTitle('Playlist añadida a la cola')
          .setDescription(`Se han añadido ${tracksToAdd.length} canciones a la cola.`)
          .addFields({ name: 'Origen de búsqueda', value: searchQuery, inline: false });
        return interaction.editReply({ embeds: [embed] });
      }

      case 'skip': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No hay nada reproduciéndose.', ephemeral: true });

        // Si es creador o usuario con permiso, salta directamente
        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.skip();
          return interaction.reply({ content: 'Canción saltada (por creador/permiso).', ephemeral: true });
        } else {
          return interaction.reply({ content: 'No puedes usar /skip. Usa /vote_skip para iniciar una votación.', ephemeral: true });
        }
      }

      case 'vote_skip': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No hay nada reproduciéndose.', ephemeral: true });

        // si es creador o permitido, permite skip directo (no necesita votar)
        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.skip();
          return interaction.reply({ content: 'Canción saltada (eres creador/tienes permiso).', ephemeral: true });
        }

        ensureVoteSet(voiceChannel.id);
        const votes = voteSkips.get(voiceChannel.id);
        if (votes.has(member.id)) return interaction.reply({ content: 'Ya votaste para saltar esta canción.', ephemeral: true });

        votes.add(member.id);

        // calcular si más de la mitad de miembros del canal votaron
        const vc = voiceChannel;
        const membersInVC = vc.members.filter(m => !m.user.bot);
        const required = Math.floor(membersInVC.size / 2) + 1; // más de la mitad
        const current = votes.size;

        if (current >= required) {
          voteSkips.set(voiceChannel.id, new Set()); // reset
          queue.skip();
          return interaction.reply({ content: `Se alcanzó la votación (${current}/${membersInVC.size}). Canción saltada.`, ephemeral: false });
        } else {
          return interaction.reply({ content: `Has votado para saltar la canción. (${current}/${required} votos necesarios)`, ephemeral: true });
        }
      }

      case 'pause': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No hay reproducción activa.', ephemeral: true });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.reply({ content: 'Solo el creador o usuarios con permiso pueden pausar.', ephemeral: true });

        queue.setPaused(true);
        return interaction.reply({ content: 'Reproducción pausada.', ephemeral: true });
      }

      case 'resume': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.reply({ content: 'Solo el creador o usuarios con permiso pueden reanudar.', ephemeral: true });

        queue.setPaused(false);
        return interaction.reply({ content: 'Reproducción reanudada.', ephemeral: true });
      }

      case 'bucle': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No hay reproducción activa.', ephemeral: true });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.reply({ content: 'Solo el creador o usuarios con permiso pueden activar el bucle.', ephemeral: true });

        queue.setRepeatMode(QueueRepeatMode.TRACK);
        return interaction.reply({ content: 'Bucle activado para la canción actual.', ephemeral: true });
      }

      case 'stopbucle': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.reply({ content: 'Solo el creador o usuarios con permiso pueden desactivar el bucle.', ephemeral: true });

        queue.setRepeatMode(QueueRepeatMode.OFF);
        return interaction.reply({ content: 'Bucle desactivado.', ephemeral: true });
      }

      case 'random': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.reply({ content: 'Solo el creador o usuarios con permiso pueden cambiar el modo aleatorio.', ephemeral: true });

        // toggle shuffle
        const isShuffled = queue.tracks._shuffled; // internal flag may not exist; we implement by shuffling tracks array
        if (!isShuffled) {
          queue.tracks.shuffle();
          // mark (non-persistent) a property so we can toggle back — not official API but works in memory
          queue.tracks._shuffled = true;
          return interaction.reply({ content: 'Cola mezclada (random activado).', ephemeral: true });
        } else {
          // no way to perfectly unshuffle; respond telling user
          delete queue.tracks._shuffled;
          return interaction.reply({ content: 'Random desactivado. La cola no puede restaurarse automáticamente a su orden original.', ephemeral: true });
        }
      }

      case 'add_permiss': {
        if (!requireVoice()) return;
        const usuario = interaction.options.getMember('usuario', true);
        const voiceChannel = member.voice.channel;
        // solo el creador puede añadir permisos
        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) return interaction.reply({ content: 'No se ha identificado el creador del canal. Solo el creador puede dar permisos.', ephemeral: true });
        if (member.id !== creator) return interaction.reply({ content: 'Solo el creador del canal puede usar este comando.', ephemeral: true });

        ensurePermSet(voiceChannel.id);
        channelPermittedUsers.get(voiceChannel.id).add(usuario.id);
        return interaction.reply({ content: `${usuario.user.tag} ahora tiene permisos para controlar la música en este canal.`, ephemeral: true });
      }

      case 'clear': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) return interaction.reply({ content: 'No se ha identificado el creador del canal. Solo el creador puede limpiar la cola.', ephemeral: true });
        if (member.id !== creator) return interaction.reply({ content: 'Solo el creador del canal puede limpiar la cola.', ephemeral: true });

        queue.clear();
        return interaction.reply({ content: 'Cola borrada (las canciones siguientes han sido eliminadas).', ephemeral: true });
      }

      case 'karaoke': {
        if (!requireVoice()) return;
        const query = interaction.options.getString('query', true);
        const voiceChannel = member.voice.channel;

        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        await interaction.deferReply();

        const queue = player.createQueue(guild, {
          metadata: { textChannel: interaction.channel, voiceChannel: voiceChannel }
        });

        if (!queue.connection) await queue.connect(voiceChannel).catch(err => {
          console.error(err);
          queue.destroy();
          return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
        });

        // Buscamos versión karaoke / instrumental
        const searchQuery = `${query} karaoke instrumental`;
        const result = await player.search(searchQuery, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!result || !result.tracks.length) {
          return interaction.editReply({ content: `No encontré versión karaoke para: ${query}` });
        }

        const track = result.tracks[0];
        await queue.addTrack(track);
        if (!queue.playing) await queue.play();

        const embed = new EmbedBuilder()
          .setTitle('Karaoke añadido a la cola')
          .setDescription(`[${track.title}](${track.url})`)
          .addFields({ name: 'Solicitado por', value: `${interaction.user.tag}`, inline: true });

        return interaction.editReply({ embeds: [embed] });
      }

      case 'help': {
        // help solo funciona si:
        // - el usuario está en canal de voz
        // OR
        // - el canal donde ejecuta el comando tiene ID en HELP_CHANNEL_IDS
        const inVoice = member && member.voice && member.voice.channel;
        const allowedChannel = HELP_CHANNEL_IDS.includes(interaction.channelId);
        if (!inVoice && !allowedChannel) {
          return interaction.reply({ content: 'El comando /help solo puede usarse en canales de voz o en canales permitidos.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('Sirgio Music Bot — Comandos')
          .setColor(HELP_COLOR)
          .setDescription('Lista de comandos disponibles y su función. (Solo tú puedes ver este mensaje)')
          .addFields(
            { name: '/play <nombre o url>', value: 'Reproduce o añade una canción a la cola.' },
            { name: '/playlist <platform> <name>', value: 'Busca y añade una playlist completa a la cola.' },
            { name: '/skip', value: 'Salta la canción si eres el creador del canal o tienes permiso.' },
            { name: '/vote_skip', value: 'Inicia o participa en una votación para saltar la canción (>50% necesarios).' },
            { name: '/pause', value: 'Pausa la reproducción (creador o con permiso).' },
            { name: '/resume', value: 'Reanuda la reproducción (creador o con permiso).' },
            { name: '/bucle', value: 'Activa bucle en la canción actual.' },
            { name: '/stopbucle', value: 'Desactiva el bucle.' },
            { name: '/random', value: 'Mezcla la cola (shuffle).' },
            { name: '/add_permiss <usuario>', value: 'El creador da permisos de control a otro usuario.' },
            { name: '/clear', value: 'El creador borra la cola (las canciones siguientes).' },
            { name: '/karaoke <nombre>', value: 'Busca y reproduce la versión karaoke/instrumental.' },
            { name: '/help', value: 'Muestra esta ayuda (solo tú la ves).' }
          )
          .setFooter({ text: 'Sirgio Music Bot' })
          .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      default:
        return interaction.reply({ content: 'Comando no implementado.', ephemeral: true });
    }
  } catch (err) {
    console.error('Error manejando interacción:', err);
    if (!interaction.replied) {
      try { interaction.reply({ content: 'Ocurrió un error al ejecutar el comando.', ephemeral: true }); } catch (e) {}
    } else {
      try { interaction.editReply({ content: 'Ocurrió un error al ejecutar el comando.' }); } catch (e) {}
    }
  }
});

/**
 * --- Manejo simple para cuando se usa por primera vez un canal de voz:
 *   Registramos quien lanzó el primer comando para considerarlo "creator"
 *   (esto lo usamos para TempVoice).
 */
client.on('voiceStateUpdate', (oldState, newState) => {
  // si un canal queda vacío y no hay cola, limpiamos datos
  try {
    const oldChannel = oldState.channel;
    if (oldChannel && oldChannel.members.filter(m => !m.user.bot).size === 0) {
      const q = player.getQueue(oldState.guild.id);
      if (!q || q.voiceChannel.id === oldChannel.id && q.tracks.length === 0) {
        // limpiar
        voiceChannelCreators.delete(oldChannel.id);
        channelPermittedUsers.delete(oldChannel.id);
        voteSkips.delete(oldChannel.id);
      }
    }
  } catch (e) {}
});

/**
 * --- Conexión del cliente ---
 */
client.login(TOKEN);
