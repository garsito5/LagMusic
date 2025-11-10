// index.js
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Collection
} = require('discord.js');

const express = require('express');
const { Player, QueryType, QueueRepeatMode } = require('discord-player');
const playdl = require('play-dl');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN || !CLIENT_ID) {
  console.warn('⚠️ TOKEN o CLIENT_ID no están definidas en las env vars. Asegúrate en Render.');
  // No exit here to allow local testing without .env — pero es recomendable definirlas.
}

/**
 * ========== Config ==========
 */
const HELP_CHANNEL_IDS = ['1422809286417059850', '1222966360263626865'];
const HELP_COLOR = 0x8A2BE2; // púrpura
const PORT = process.env.PORT || 3000;

/**
 * ========== Cliente y Player ==========
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
 * ========== Datos en memoria ==========
 *
 * voiceChannelCreators: channelId -> userId (quien creó / primer user en TempVoice)
 * channelPermittedUsers: channelId -> Set(userId)  (usuarios a los que el creador dio permisos)
 * voteSkips: channelId -> Set(userId) (votos del skip actuales)
 * history: channelId -> [ trackInfo ]  (historial reproducido en ese canal - para /any)
 */
const voiceChannelCreators = new Map();
const channelPermittedUsers = new Map();
const voteSkips = new Map();
const channelHistory = new Map();

/** Helpers para sets/maps */
function ensurePermSet(vcId) {
  if (!channelPermittedUsers.has(vcId)) channelPermittedUsers.set(vcId, new Set());
}
function ensureVoteSet(vcId) {
  if (!voteSkips.has(vcId)) voteSkips.set(vcId, new Set());
}
function ensureHistory(vcId) {
  if (!channelHistory.has(vcId)) channelHistory.set(vcId, []);
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
 * ========== Auto-registro de comandos (por guilds cacheadas) ==========
 * Definimos todos los comandos que pediste: play, play_playlist, skip, vote_skip,
 * pause, resume, bucle, stop_bucle, random, any, add_permiss, clear, karaoke, ping, help
 */
const slashCommands = [
  {
    name: 'play',
    description: 'Reproduce una canción o la añade a la cola',
    options: [
      { name: 'query', description: 'Nombre o URL de la canción', type: 3, required: true }
    ]
  },
  {
    name: 'play_playlist',
    description: 'Reproduce una playlist (URL o platform + nombre)',
    options: [
      { name: 'platform', description: 'Plataforma (youtube/spotify/ytmusic/soundcloud) o "url"', type: 3, required: false },
      { name: 'name', description: 'Nombre de la playlist o URL', type: 3, required: true }
    ]
  },
  { name: 'skip', description: 'Salta la canción (solo creador o usuario con permiso)' },
  { name: 'vote_skip', description: 'Vota para saltar la canción (si >50% del canal vota, se salta)' },
  { name: 'pause', description: 'Pausa la canción' },
  { name: 'resume', description: 'Reanuda la canción' },
  { name: 'bucle', description: 'Activa bucle en la canción actual' },
  { name: 'stop_bucle', description: 'Desactiva el bucle' },
  { name: 'random', description: 'Activa/desactiva modo aleatorio (shuffle) de la cola' },
  { name: 'any', description: 'Reproduce cualquier canción aleatoria de la playlist actual o historial' },
  {
    name: 'add_permiss',
    description: 'El creador del canal da permisos a otro usuario',
    options: [{ name: 'usuario', description: 'Usuario a quien dar permisos', type: 6, required: true }]
  },
  { name: 'clear', description: 'El creador borra las siguientes canciones de la cola' },
  {
    name: 'karaoke',
    description: 'Busca y reproduce una versión karaoke/instrumental de la canción',
    options: [{ name: 'query', description: 'Nombre de la canción', type: 3, required: true }]
  },
  { name: 'ping', description: 'Muestra la latencia del bot' },
  { name: 'help', description: 'Muestra los comandos (solo en voz o canales permitidos)' }
];

client.once('ready', async () => {
  console.log(`✅ Conectado como ${client.user.tag}`);

  try {
    // Registrar comandos en cada guild cacheada (rápido)
    const guildIds = client.guilds.cache.map(g => g.id);
    for (const gid of guildIds) {
      const guild = await client.guilds.fetch(gid).catch(() => null);
      if (!guild) continue;
      await guild.commands.set(slashCommands);
      console.log(`Comandos registrados en guild ${gid}`);
    }
  } catch (err) {
    console.warn('No se pudieron registrar todos los comandos:', err?.message ?? err);
  }

  // Express keep-alive
  const app = express();
  app.get('/', (req, res) => res.send('Sirgio Music Bot (Music) alive'));
  app.listen(PORT, () => console.log(`🌐 Web server listening on ${PORT}`));
});

/**
 * ========== Player events ==========
 * Cuando empieza una pista guardamos en historial y limpiamos votos.
 */
player.on('trackStart', (queue, track) => {
  try {
    const vcId = queue.metadata.voiceChannel.id;
    // reset votes for this track
    voteSkips.set(vcId, new Set());
    ensureHistory(vcId);
    const h = channelHistory.get(vcId);
    // push a compact track info (limitar tamaño del historial)
    h.push({ title: track.title, url: track.url, requestedBy: track.requestedBy?.id ?? null });
    if (h.length > 200) h.shift();

    const embed = new EmbedBuilder()
      .setTitle('▶ Reproduciendo ahora')
      .setDescription(`[${track.title}](${track.url})`)
      .addFields(
        { name: 'Duración', value: track.duration ?? 'Desconocida', inline: true },
        { name: 'Solicitado por', value: `${track.requestedBy?.username ?? 'Desconocido'}`, inline: true }
      )
      .setTimestamp();

    // send a short notification to text channel
    if (queue.metadata && queue.metadata.textChannel) {
      queue.metadata.textChannel.send({ embeds: [embed] }).catch(() => { });
    }
  } catch (e) { /* ignore */ }
});

player.on('queueEnd', (queue) => {
  try {
    const vcId = queue.metadata.voiceChannel.id;
    // limpiamos maps relacionados
    voiceChannelCreators.delete(vcId);
    channelPermittedUsers.delete(vcId);
    voteSkips.delete(vcId);
    // Responder en texto que la cola terminó
    if (queue.metadata && queue.metadata.textChannel) {
      queue.metadata.textChannel.send('La cola ha terminado. Me desconecto.').catch(() => { });
    }
  } catch (e) { /* ignore */ }
});

player.on('error', (queue, error) => {
  console.error('Player error:', error);
});

/**
 * ========== Interaction handler (slash commands) ==========
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  const member = interaction.member;
  const guild = interaction.guild;

  // Utility: require the user to be in voice for most commands (with proper message)
  const requireVoice = (reply = true) => {
    if (!member || !member.voice || !member.voice.channel) {
      if (reply) interaction.reply({ content: 'Tienes que estar en un canal de voz para usar este comando.', ephemeral: true });
      return false;
    }
    return true;
  };

  try {
    // Defer reply when we expect some processing (so Discord doesn't show "La aplicación no ha respondido")
    await interaction.deferReply({ ephemeral: true });

    switch (commandName) {
      // -------------------- PLAY (busca canción y la agrega) --------------------
      case 'play': {
        if (!requireVoice()) return;
        const query = interaction.options.getString('query', true);
        const voiceChannel = member.voice.channel;

        // registrar creador si no existe
        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        // crear / obtener queue para guild
        const queue = player.createQueue(guild, {
          metadata: { textChannel: interaction.channel, voiceChannel: voiceChannel }
        });

        // conectar si es necesario
        if (!queue.connection) {
          try {
            await queue.connect(voiceChannel);
          } catch (err) {
            queue.destroy();
            return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
          }
        }

        // Buscar la canción (auto engine)
        const searchResult = await player.search(query, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!searchResult || !searchResult.tracks.length) {
          return interaction.editReply({ content: `No se encontró la canción: ${query}` });
        }

        // Si es playlist en búsqueda automática, manejar tracks
        if (searchResult.playlist) {
          await queue.addTracks(searchResult.playlist.tracks);
          if (!queue.playing) await queue.play();
          return interaction.editReply({ content: `Playlist añadida: ${searchResult.playlist.title} — ${searchResult.tracks.length} canciones.` });
        } else {
          const track = searchResult.tracks[0];
          await queue.addTrack(track);
          if (!queue.playing) await queue.play();
          return interaction.editReply({ content: `Añadido a la cola: **${track.title}**` });
        }
      }

      // -------------------- PLAY_PLAYLIST (url o platform+name) --------------------
      case 'play_playlist': {
        if (!requireVoice()) return;
        const platform = interaction.options.getString('platform', false);
        const name = interaction.options.getString('name', true);
        const voiceChannel = member.voice.channel;

        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        const queue = player.createQueue(guild, {
          metadata: { textChannel: interaction.channel, voiceChannel: voiceChannel }
        });

        if (!queue.connection) {
          try {
            await queue.connect(voiceChannel);
          } catch (err) {
            queue.destroy();
            return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
          }
        }

        // Si el usuario pasó una URL real (youtube/spotify), dejemos que player la detecte
        let searchQuery = name;
        if (platform && platform.toLowerCase() !== 'url') {
          searchQuery = `${platform} playlist ${name}`;
        }

        const result = await player.search(searchQuery, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!result || !result.tracks.length) {
          return interaction.editReply({ content: `No encontré la playlist: ${platform ?? ''} ${name}` });
        }

        // Añadir todas las tracks
        const tracksToAdd = result.playlist ? result.playlist.tracks : result.tracks;
        await queue.addTracks(tracksToAdd);
        if (!queue.playing) await queue.play();

        return interaction.editReply({ content: `Se añadieron ${tracksToAdd.length} canciones a la cola.` });
      }

      // -------------------- SKIP --------------------
      case 'skip': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.editReply({ content: 'No hay nada reproduciéndose.' });

        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.skip();
          return interaction.editReply({ content: 'Canción saltada (creador/permiso).' });
        } else {
          return interaction.editReply({ content: 'No puedes usar /skip directamente. Usa /vote_skip para iniciar una votación.' });
        }
      }

      // -------------------- VOTE_SKIP --------------------
      case 'vote_skip': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.editReply({ content: 'No hay nada reproduciéndose.' });

        // Si es creator o tiene permiso, skip directo
        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.skip();
          return interaction.editReply({ content: 'Canción saltada (eres creador/tienes permiso).' });
        }

        ensureVoteSet(voiceChannel.id);
        const votes = voteSkips.get(voiceChannel.id);
        if (votes.has(member.id)) return interaction.editReply({ content: 'Ya votaste para saltar esta canción.' });

        votes.add(member.id);

        // calcular required = más de la mitad de los miembros humanos del canal
        const membersInVC = voiceChannel.members.filter(m => !m.user.bot);
        const required = Math.floor(membersInVC.size / 2) + 1;
        const current = votes.size;

        if (current >= required) {
          voteSkips.set(voiceChannel.id, new Set());
          queue.skip();
          return interaction.editReply({ content: `Se alcanzó la votación (${current}/${membersInVC.size}). Canción saltada.` });
        } else {
          return interaction.editReply({ content: `Has votado para saltar la canción. (${current}/${required} votos necesarios)` });
        }
      }

      // -------------------- PAUSE --------------------
      case 'pause': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.editReply({ content: 'No hay reproducción activa.' });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden pausar.' });

        queue.setPaused(true);
        return interaction.editReply({ content: 'Reproducción pausada.' });
      }

      // -------------------- RESUME --------------------
      case 'resume': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.editReply({ content: 'No hay cola activa.' });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden reanudar.' });

        queue.setPaused(false);
        return interaction.editReply({ content: 'Reproducción reanudada.' });
      }

      // -------------------- BUCLE --------------------
      case 'bucle': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || !queue.playing) return interaction.editReply({ content: 'No hay reproducción activa.' });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden activar el bucle.' });

        queue.setRepeatMode(QueueRepeatMode.TRACK);
        return interaction.editReply({ content: 'Bucle activado para la canción actual.' });
      }

      // -------------------- STOP_BUCLE --------------------
      case 'stop_bucle': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.editReply({ content: 'No hay cola activa.' });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden desactivar el bucle.' });

        queue.setRepeatMode(QueueRepeatMode.OFF);
        return interaction.editReply({ content: 'Bucle desactivado.' });
      }

      // -------------------- RANDOM (shuffle) --------------------
      case 'random': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue || queue.tracks.size === 0) return interaction.editReply({ content: 'No hay canciones en la cola.' });

        if (!isCreatorOrPermitted(member, voiceChannel.id)) return interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden cambiar el modo aleatorio.' });

        // shuffle helper (discord-player tiene shuffle en tracks)
        try {
          queue.tracks.shuffle();
          return interaction.editReply({ content: 'Cola mezclada (random activado).' });
        } catch (e) {
          return interaction.editReply({ content: 'No se pudo mezclar la cola.' });
        }
      }

      // -------------------- ANY --------------------
      case 'any': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        const vcId = voiceChannel.id;

        ensureHistory(vcId);
        const history = channelHistory.get(vcId) || [];

        // Si hay cola actual, elegimos de la cola o history segun disponibilidad
        const pool = [];
        if (queue && queue.tracks && queue.tracks.size > 0) {
          // incluir la cola actual (tracks que quedan)
          for (const t of queue.tracks.toArray()) pool.push({ title: t.title, url: t.url });
        }
        // añadir historial
        for (const h of history) pool.push({ title: h.title, url: h.url });

        if (!pool.length) return interaction.editReply({ content: 'No hay canciones en la playlist ni historial para seleccionar.' });

        const choice = pool[Math.floor(Math.random() * pool.length)];

        // reproducir la elección: añadir a la cola y si no se está reproduciendo, iniciar
        const mainQueue = player.createQueue(guild, {
          metadata: { textChannel: interaction.channel, voiceChannel }
        });
        if (!mainQueue.connection) {
          try {
            await mainQueue.connect(voiceChannel);
          } catch (err) {
            mainQueue.destroy();
            return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
          }
        }

        const res = await player.search(choice.url || choice.title, {
          requestedBy: interaction.user,
          searchEngine: QueryType.AUTO
        });

        if (!res || !res.tracks.length) return interaction.editReply({ content: 'No pude encontrar la canción seleccionada.' });

        await mainQueue.addTrack(res.tracks[0]);
        if (!mainQueue.playing) await mainQueue.play();

        return interaction.editReply({ content: `Reproduciendo canción aleatoria: **${res.tracks[0].title}**` });
      }

      // -------------------- ADD_PERMISS --------------------
      case 'add_permiss': {
        if (!requireVoice()) return;
        const usuario = interaction.options.getMember('usuario', true);
        const voiceChannel = member.voice.channel;
        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) return interaction.editReply({ content: 'No se ha identificado el creador del canal.' });
        if (member.id !== creator) return interaction.editReply({ content: 'Solo el creador del canal puede usar este comando.' });

        ensurePermSet(voiceChannel.id);
        channelPermittedUsers.get(voiceChannel.id).add(usuario.id);

        return interaction.editReply({ content: `${usuario.user.tag} ahora tiene permisos en este canal para controlar la música.` });
      }

      // -------------------- CLEAR --------------------
      case 'clear': {
        if (!requireVoice()) return;
        const voiceChannel = member.voice.channel;
        const queue = player.getQueue(guild.id);
        if (!queue) return interaction.editReply({ content: 'No hay cola activa.' });

        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) return interaction.editReply({ content: 'No se ha identificado el creador del canal.' });
        if (member.id !== creator) return interaction.editReply({ content: 'Solo el creador del canal puede limpiar la cola.' });

        queue.clear();
        return interaction.editReply({ content: 'Cola borrada (las canciones siguientes han sido eliminadas).' });
      }

      // -------------------- KARAOKE --------------------
      case 'karaoke': {
        if (!requireVoice()) return;
        const query = interaction.options.getString('query', true);
        const voiceChannel = member.voice.channel;

        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        const queue = player.createQueue(guild, {
          metadata: { textChannel: interaction.channel, voiceChannel }
        });

        if (!queue.connection) {
          try {
            await queue.connect(voiceChannel);
          } catch (err) {
            queue.destroy();
            return interaction.editReply({ content: 'No pude conectar al canal de voz.' });
          }
        }

        // Buscar versión karaoke/instrumental
        const searchQuery = `${query} karaoke instrumental`;
        const result = await player.search(searchQuery, {
          requestedBy: interaction.user,
          searchEngine: QueryType.YOUTUBE_VIDEO
        });

        if (!result || !result.tracks.length) {
          return interaction.editReply({ content: `No encontré versión karaoke para: ${query}` });
        }

        const track = result.tracks[0];
        await queue.addTrack(track);
        if (!queue.playing) await queue.play();

        return interaction.editReply({ content: `Karaoke añadido a la cola: **${track.title}**` });
      }

      // -------------------- PING --------------------
      case 'ping': {
        return interaction.editReply({ content: `Pong! Latencia websocket: ${client.ws.ping}ms` });
      }

      // -------------------- HELP --------------------
      case 'help': {
        const inVoice = member && member.voice && member.voice.channel;
        const allowedChannel = HELP_CHANNEL_IDS.includes(interaction.channelId);
        if (!inVoice && !allowedChannel) {
          return interaction.editReply({ content: 'El comando /help solo puede usarse en canales de voz o en los canales permitidos.' });
        }

        const embed = new EmbedBuilder()
          .setTitle('Sirgio Music Bot — Comandos')
          .setColor(HELP_COLOR)
          .setDescription('Lista de comandos disponibles y su función (solo tú puedes ver esto).')
          .addFields(
            { name: '/play <nombre|url>', value: 'Reproduce una canción o la añade a la cola.' },
            { name: '/play_playlist <platform?> <name|url>', value: 'Añade una playlist (URL o búsqueda por plataforma).' },
            { name: '/skip', value: 'Salta la canción (creador o usuario con permiso).' },
            { name: '/vote_skip', value: 'Votación para saltar la canción (>50% del canal).' },
            { name: '/pause', value: 'Pausa la reproducción.' },
            { name: '/resume', value: 'Reanuda la reproducción.' },
            { name: '/bucle', value: 'Activa bucle en la canción actual.' },
            { name: '/stop_bucle', value: 'Desactiva el bucle.' },
            { name: '/random', value: 'Mezcla la cola.' },
            { name: '/any', value: 'Reproduce cualquier canción de la playlist o del historial del canal de voz.' },
            { name: '/add_permiss <usuario>', value: 'El creador da permisos de control a otro usuario.' },
            { name: '/clear', value: 'El creador borra la cola (las siguientes canciones).' },
            { name: '/karaoke <canción>', value: 'Busca y reproduce la versión karaoke/instrumental.' },
            { name: '/ping', value: 'Muestra latencia.' }
          )
          .setFooter({ text: 'Sirgio Music Bot' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed], ephemeral: true });
      }

      default:
        return interaction.editReply({ content: 'Comando no implementado aún.' });
    }
  } catch (err) {
    console.error('Error ejecutando comando:', err);
    try {
      if (!interaction.replied) {
        return interaction.reply({ content: 'Ocurrió un error al ejecutar el comando.', ephemeral: true });
      } else {
        return interaction.editReply({ content: 'Ocurrió un error al ejecutar el comando.' });
      }
    } catch (e) { /* ignore */ }
  }
});

/**
 * ========== Limpieza cuando el canal de voz queda vacío ==========
 * Si el canal de voz queda vacío, y la cola no tiene canciones, limpiamos el estado.
 */
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    if (oldState.channel && oldState.channel.members.filter(m => !m.user.bot).size === 0) {
      // si no hay humanos en el canal
      const vc = oldState.channel;
      // obtenemos la cola del guild, si existe y corresponde a ese canal y está vacía -> limpiar
      const q = player.getQueue(oldState.guild.id);
      if (!q) {
        voiceChannelCreators.delete(vc.id);
        channelPermittedUsers.delete(vc.id);
        voteSkips.delete(vc.id);
        channelHistory.delete(vc.id);
      } else {
        // si la queue existe pero es de ese canal y no tiene tracks
        if (q.voiceChannel && q.voiceChannel.id === vc.id && (!q.tracks || q.tracks.size === 0)) {
          q.destroy();
          voiceChannelCreators.delete(vc.id);
          channelPermittedUsers.delete(vc.id);
          voteSkips.delete(vc.id);
          channelHistory.delete(vc.id);
        }
      }
    }
  } catch (e) { /* ignore */ }
});

/**
 * ========== Login ==========
 */
client.login(TOKEN).catch(err => {
  console.error('Error al loguear el bot:', err);
});
