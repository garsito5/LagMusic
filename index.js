// index.js
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
} = require('discord.js');

const express = require('express');
const { Player, QueryType, QueueRepeatMode } = require('discord-player');
const playdl = require('play-dl');

// Cargar extractores de play-dl (necesario para YouTube, Spotify, etc.)
(async () => {
  try {
    await playdl.extractors.load();
    console.log("✅ Extractores de play-dl cargados correctamente.");
  } catch (err) {
    console.error("❌ Error al cargar extractores:", err);
  }
})();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;


if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.warn('⚠️ TOKEN, CLIENT_ID o GUILD_ID no están definidas en las env vars. Revisa Render.');
  // seguir para debugging local, pero en producción debes definirlas
}

/** CONFIG */
const HELP_CHANNEL_IDS = ['1422809286417059850', '1222966360263626865'];
const HELP_COLOR = 0x8A2BE2; // púrpura

/** CLIENT & PLAYER */
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

/** IN-MEMORY STATE */
const voiceChannelCreators = new Map();      // channelId -> userId (creator)
const channelPermittedUsers = new Map();    // channelId -> Set(userId)
const voteSkips = new Map();                // channelId -> Set(userId)
const channelHistory = new Map();           // channelId -> [{title,url,requestedBy}]
function ensurePermSet(vcId) { if (!channelPermittedUsers.has(vcId)) channelPermittedUsers.set(vcId, new Set()); }
function ensureVoteSet(vcId) { if (!voteSkips.has(vcId)) voteSkips.set(vcId, new Set()); }
function ensureHistory(vcId) { if (!channelHistory.has(vcId)) channelHistory.set(vcId, []); }
function isCreatorOrPermitted(member, voiceChannelId) {
  if (!member) return false;
  const creator = voiceChannelCreators.get(voiceChannelId);
  if (creator && member.id === creator) return true;
  const set = channelPermittedUsers.get(voiceChannelId);
  if (set && set.has(member.id)) return true;
  return false;
}

/** SLASH COMMANDS (GUILD ONLY) - required options first */
const slashCommands = [
  {
    name: 'play',
    description: 'Reproduce una canción o la añade a la cola (acepta nombre o enlace)',
    options: [
      { name: 'query', description: 'Nombre o URL de la canción', type: 3, required: true }
    ]
  },
  {
    name: 'play_playlist',
    description: 'Reproduce una playlist (URL o platform + name)',
    options: [
      { name: 'name', description: 'URL o nombre de la playlist', type: 3, required: true },
      { name: 'platform', description: 'Plataforma (youtube, spotify, ytmusic, soundcloud) — opcional', type: 3, required: false }
    ]
  },
  { name: 'skip', description: 'Salta la canción actual (solo creador o usuarios con permiso)' },
  { name: 'vote_skip', description: 'Vota para saltar la canción (>50% del canal)' },
  { name: 'pause', description: 'Pausa la canción' },
  { name: 'resume', description: 'Reanuda la canción' },
  { name: 'bucle', description: 'Activa bucle en la canción actual' },
  { name: 'stop_bucle', description: 'Desactiva el bucle' },
  { name: 'random', description: 'Mezcla la cola (shuffle)' },
  { name: 'any', description: 'Reproduce cualquier canción de la playlist o del historial del canal de voz' },
  {
    name: 'add_permiss',
    description: 'El creador da permisos a otro usuario',
    options: [{ name: 'usuario', description: 'Usuario a quien dar permisos', type: 6, required: true }]
  },
  { name: 'clear', description: 'El creador borra las siguientes canciones de la cola' },
  {
    name: 'karaoke',
    description: 'Busca y reproduce la versión karaoke/instrumental de la canción',
    options: [{ name: 'query', description: 'Nombre de la canción', type: 3, required: true }]
  },
  { name: 'ping', description: 'Muestra latencia' },
  { name: 'help', description: 'Muestra los comandos (solo en voz o canales permitidos)' }
];

/** REGISTER GUILD COMMANDS */
client.once('ready', async () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: slashCommands });
    console.log(`✅ Slash commands registrados en guild ${GUILD_ID}`);
  } catch (err) {
    console.error('❌ Error registrando comandos en guild:', err);
  }

  // Express keep-alive
  const app = express();
  app.get('/', (req, res) => res.send('Sirgio Music Bot (music) - alive'));
  app.listen(PORT, () => console.log(`🌐 Web server listening on ${PORT}`));
});

/** PLAYER EVENTS: historial + reset votos + now playing embed */
player.on('trackStart', (queue, track) => {
  try {
    const vcId = queue.metadata.voiceChannel.id;
    voteSkips.set(vcId, new Set());
    ensureHistory(vcId);
    const h = channelHistory.get(vcId);
    h.push({ title: track.title, url: track.url, requestedBy: track.requestedBy?.id ?? null });
    if (h.length > 300) h.shift();

    const embed = new EmbedBuilder()
      .setTitle('▶ Reproduciendo ahora')
      .setDescription(`[${track.title}](${track.url})`)
      .addFields(
        { name: 'Duración', value: track.duration ?? 'Desconocida', inline: true },
        { name: 'Solicitado por', value: `${track.requestedBy?.tag ?? 'Desconocido'}`, inline: true }
      )
      .setTimestamp()
      .setColor(HELP_COLOR);

    if (queue.metadata && queue.metadata.textChannel) {
      queue.metadata.textChannel.send({ embeds: [embed] }).catch(() => {});
    }
  } catch (e) { console.error('trackStart err', e); }
});

player.on('queueEnd', (queue) => {
  try {
    const vcId = queue.metadata.voiceChannel.id;
    voiceChannelCreators.delete(vcId);
    channelPermittedUsers.delete(vcId);
    voteSkips.delete(vcId);
    channelHistory.delete(vcId);
    if (queue.metadata && queue.metadata.textChannel) {
      queue.metadata.textChannel.send('La cola ha terminado. Me desconecto.').catch(() => {});
    }
  } catch (e) { console.error('queueEnd err', e); }
});

player.on('error', (queue, error) => {
  console.error('Player error:', error);
});

/** INTERACTION HANDLER */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Defer the reply as ephemeral using flags (64) to avoid deprecation and allow time
  try {
    await interaction.deferReply({ flags: 64 }); // 64 -> EPHEMERAL
  } catch (e) {
    // sometimes defer fails if interaction already invalid; log and continue
    console.warn('deferReply failed:', e?.message ?? e);
  }

  const { commandName } = interaction;
  const member = interaction.member;
  const guild = interaction.guild;

  const requireVoice = (reply = true) => {
    if (!member || !member.voice || !member.voice.channel) {
      if (reply) {
        try { interaction.editReply({ content: 'Tienes que estar en un canal de voz para usar este comando.' }); } catch (e) {}
      }
      return false;
    }
    return true;
  };

  try {
    switch (commandName) {
    // ---------------- PLAY (nombre o url con compatibilidad actualizada)
case 'play': {
  if (!requireVoice()) break;
  const query = interaction.options.getString('query', true);
  const voiceChannel = member.voice.channel;

  if (!voiceChannelCreators.has(voiceChannel.id))
    voiceChannelCreators.set(voiceChannel.id, member.id);

  const queue = player.nodes.create(guild, {
    metadata: { textChannel: interaction.channel, voiceChannel },
  });

  if (!queue.connection) {
    try {
      await queue.connect(voiceChannel);
    } catch (err) {
      queue.delete();
      await interaction.editReply({ content: 'No pude conectar al canal de voz.' });
      break;
    }
  }

  let searchResult;

  try {
    // Si es enlace directo, usar play-dl para asegurar compatibilidad
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      const info = await playdl.video_info(query);
      if (!info || !info.video_details) throw new Error('Video no encontrado');
      const stream = await playdl.stream_from_info(info, { quality: 2 });
      searchResult = {
        tracks: [
          {
            title: info.video_details.title,
            url: info.video_details.url,
            duration: info.video_details.durationRaw,
            requestedBy: interaction.user,
            raw: stream,
          },
        ],
      };
    } else {
      // Si no es URL, buscar por nombre
      searchResult = await player.search(query, {
        requestedBy: interaction.user,
        searchEngine: QueryType.YOUTUBE_SEARCH,
      });
    }
  } catch (err) {
    console.error('Error buscando canción:', err);
    await interaction.editReply({ content: `❌ Error buscando: ${query}` });
    break;
  }

  if (!searchResult || !searchResult.tracks.length) {
    await interaction.editReply({ content: `No se encontró la canción: ${query}` });
    break;
  }

  const track = searchResult.tracks[0];
  await queue.addTrack(track);
  if (!queue.playing) await queue.play();

  await interaction.editReply({ content: `🎵 Añadido a la cola: **${track.title}**` });
  break;
}

      // ---------------- PLAY_PLAYLIST
      case 'play_playlist': {
        if (!requireVoice()) break;
        const name = interaction.options.getString('name', true);
        const platform = interaction.options.getString('platform', false);
        const voiceChannel = member.voice.channel;

        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        const queue = player.nodes.create(guild, { metadata: { textChannel: interaction.channel, voiceChannel } });
        if (!queue.connection) {
          try { await queue.connect(voiceChannel); } catch (err) { queue.destroy(); await interaction.editReply({ content: 'No pude conectar al canal de voz.' }); break; }
        }

        let searchQuery = name;
        if (platform && platform.toLowerCase() !== 'url') searchQuery = `${platform} playlist ${name}`;

        const result = await player.search(searchQuery, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
        if (!result || !result.tracks.length) { await interaction.editReply({ content: `No encontré la playlist: ${platform ?? ''} ${name}` }); break; }

        const tracksToAdd = result.playlist ? result.playlist.tracks : result.tracks;
        await queue.addTracks(tracksToAdd);
        if (!queue.playing) await queue.play();
        await interaction.editReply({ content: `Se añadieron ${tracksToAdd.length} canciones a la cola.` });
        break;
      }

      // ---------------- SKIP
      case 'skip': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue || !queue.playing) { await interaction.editReply({ content: 'No hay nada reproduciéndose.' }); break; }

        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.node.skip();
          await interaction.editReply({ content: 'Canción saltada (creador/permiso).' });
        } else {
          await interaction.editReply({ content: 'No puedes usar /skip directamente. Usa /vote_skip para iniciar una votación.' });
        }
        break;
      }

      // ---------------- VOTE_SKIP
      case 'vote_skip': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue || !queue.playing) { await interaction.editReply({ content: 'No hay nada reproduciéndose.' }); break; }

        if (isCreatorOrPermitted(member, voiceChannel.id)) {
          queue.node.skip();
          await interaction.editReply({ content: 'Canción saltada (eres creador/tienes permiso).' });
          break;
        }

        ensureVoteSet(voiceChannel.id);
        const votes = voteSkips.get(voiceChannel.id);
        if (votes.has(member.id)) { await interaction.editReply({ content: 'Ya votaste para saltar esta canción.' }); break; }
        votes.add(member.id);

        const membersInVC = voiceChannel.members.filter(m => !m.user.bot);
        const required = Math.floor(membersInVC.size / 2) + 1;
        const current = votes.size;

        if (current >= required) {
          voteSkips.set(voiceChannel.id, new Set());
          queue.node.skip();
          await interaction.editReply({ content: `Se alcanzó la votación (${current}/${membersInVC.size}). Canción saltada.` });
        } else {
          await interaction.editReply({ content: `Has votado para saltar la canción. (${current}/${required} votos necesarios)` });
        }
        break;
      }

      // ---------------- PAUSE
      case 'pause': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue || !queue.playing) { await interaction.editReply({ content: 'No hay reproducción activa.' }); break; }
        if (!isCreatorOrPermitted(member, voiceChannel.id)) { await interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden pausar.' }); break; }
        queue.node.pause();
        await interaction.editReply({ content: 'Reproducción pausada.' });
        break;
      }

      // ---------------- RESUME
      case 'resume': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue) { await interaction.editReply({ content: 'No hay cola activa.' }); break; }
        if (!isCreatorOrPermitted(member, voiceChannel.id)) { await interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden reanudar.' }); break; }
        queue.node.resume();
        await interaction.editReply({ content: 'Reproducción reanudada.' });
        break;
      }

      // ---------------- BUCLE
      case 'bucle': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue || !queue.playing) { await interaction.editReply({ content: 'No hay reproducción activa.' }); break; }
        if (!isCreatorOrPermitted(member, voiceChannel.id)) { await interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden activar el bucle.' }); break; }
        queue.setRepeatMode(QueueRepeatMode.TRACK);
        await interaction.editReply({ content: 'Bucle activado para la canción actual.' });
        break;
      }

      // ---------------- STOP_BUCLE
      case 'stop_bucle': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue) { await interaction.editReply({ content: 'No hay cola activa.' }); break; }
        if (!isCreatorOrPermitted(member, voiceChannel.id)) { await interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden desactivar el bucle.' }); break; }
        queue.setRepeatMode(QueueRepeatMode.OFF);
        await interaction.editReply({ content: 'Bucle desactivado.' });
        break;
      }

      // ---------------- RANDOM
      case 'random': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue || !queue.tracks || queue.tracks.size === 0) { await interaction.editReply({ content: 'No hay canciones en la cola.' }); break; }
        if (!isCreatorOrPermitted(member, voiceChannel.id)) { await interaction.editReply({ content: 'Solo el creador o usuarios con permiso pueden mezclar la cola.' }); break; }
        queue.tracks.shuffle();
        await interaction.editReply({ content: 'Cola mezclada (random activado).' });
        break;
      }

      // ---------------- ANY
      case 'any': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const vcId = voiceChannel.id;
        ensureHistory(vcId);
        const history = channelHistory.get(vcId) || [];
        const queue = player.nodes.get(guild.id);
        const pool = [];

        if (queue && queue.tracks && queue.tracks.size > 0) {
          for (const t of queue.tracks.toArray()) pool.push({ title: t.title, url: t.url });
        }
        for (const h of history) pool.push({ title: h.title, url: h.url });

        if (!pool.length) { await interaction.editReply({ content: 'No hay canciones en la playlist ni historial para seleccionar.' }); break; }

        const choice = pool[Math.floor(Math.random() * pool.length)];
        const mainQueue = player.nodes.create(guild, { metadata: { textChannel: interaction.channel, voiceChannel } });
        if (!mainQueue.connection) {
          try { await mainQueue.connect(voiceChannel); } catch (err) { mainQueue.destroy(); await interaction.editReply({ content: 'No pude conectar al canal de voz.' }); break; }
        }

        const res = await player.search(choice.url || choice.title, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
        if (!res || !res.tracks.length) { await interaction.editReply({ content: 'No pude encontrar la canción seleccionada.' }); break; }
        await mainQueue.addTrack(res.tracks[0]);
        if (!mainQueue.playing) await mainQueue.play();
        await interaction.editReply({ content: `Reproduciendo canción aleatoria: **${res.tracks[0].title}**` });
        break;
      }

      // ---------------- ADD_PERMISS
      case 'add_permiss': {
        if (!requireVoice()) break;
        const usuario = interaction.options.getMember('usuario', true);
        const voiceChannel = member.voice.channel;
        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) { await interaction.editReply({ content: 'No se ha identificado el creador del canal.' }); break; }
        if (member.id !== creator) { await interaction.editReply({ content: 'Solo el creador del canal puede usar este comando.' }); break; }
        ensurePermSet(voiceChannel.id);
        channelPermittedUsers.get(voiceChannel.id).add(usuario.id);
        await interaction.editReply({ content: `${usuario.user.tag} ahora tiene permisos para controlar la música en este canal.` });
        break;
      }

      // ---------------- CLEAR
      case 'clear': {
        if (!requireVoice()) break;
        const voiceChannel = member.voice.channel;
        const queue = player.nodes.get(guild.id);
        if (!queue) { await interaction.editReply({ content: 'No hay cola activa.' }); break; }
        const creator = voiceChannelCreators.get(voiceChannel.id);
        if (!creator) { await interaction.editReply({ content: 'No se ha identificado el creador del canal.' }); break; }
        if (member.id !== creator) { await interaction.editReply({ content: 'Solo el creador del canal puede limpiar la cola.' }); break; }
        queue.clear();
        await interaction.editReply({ content: 'Cola borrada (las canciones siguientes han sido eliminadas).' });
        break;
      }

      // ---------------- KARAOKE
      case 'karaoke': {
        if (!requireVoice()) break;
        const query = interaction.options.getString('query', true);
        const voiceChannel = member.voice.channel;
        if (!voiceChannelCreators.has(voiceChannel.id)) voiceChannelCreators.set(voiceChannel.id, member.id);

        const queue = player.nodes.create(guild, { metadata: { textChannel: interaction.channel, voiceChannel } });
        if (!queue.connection) {
          try { await queue.connect(voiceChannel); } catch (err) { queue.destroy(); await interaction.editReply({ content: 'No pude conectar al canal de voz.' }); break; }
        }

        const searchQuery = `${query} karaoke instrumental`;
        const result = await player.search(searchQuery, { requestedBy: interaction.user, searchEngine: QueryType.YOUTUBE_VIDEO });
        if (!result || !result.tracks.length) { await interaction.editReply({ content: `No encontré versión karaoke para: ${query}` }); break; }

        const track = result.tracks[0];
        await queue.addTrack(track);
        if (!queue.playing) await queue.play();
        await interaction.editReply({ content: `Karaoke añadido a la cola: **${track.title}**` });
        break;
      }

      // ---------------- PING
      case 'ping': {
        await interaction.editReply({ content: `Pong! Latencia websocket: ${client.ws.ping}ms` });
        break;
      }

      // ---------------- HELP
      case 'help': {
        const inVoice = member && member.voice && member.voice.channel;
        const allowedChannel = HELP_CHANNEL_IDS.includes(interaction.channelId);
        if (!inVoice && !allowedChannel) { await interaction.editReply({ content: 'El comando /help solo puede usarse en canales de voz o en los canales permitidos.' }); break; }

        const embed = new EmbedBuilder()
          .setTitle('Sirgio Music Bot — Comandos')
          .setColor(HELP_COLOR)
          .setDescription('Lista de comandos disponibles y su función (solo tú puedes ver esto).')
          .addFields(
            { name: '/play <nombre|url>', value: 'Reproduce una canción o la añade a la cola.' },
            { name: '/play_playlist <name> [platform]', value: 'Añade una playlist (URL o búsqueda por plataforma).' },
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

        await interaction.editReply({ embeds: [embed] }); // deferred with flags:64 so user will see ephemeral reply
        break;
      }

      default:
        await interaction.editReply({ content: 'Comando no implementado.' });
        break;
    }
  } catch (err) {
    console.error('Error ejecutando comando:', err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Ocurrió un error al ejecutar el comando: ${err.message}` });
      } else {
        await interaction.reply({ content: `Ocurrió un error al ejecutar el comando: ${err.message}`, flags: 64 });
      }
    } catch (e) { console.error('Error informando al usuario:', e); }
  }
});

/** CLEANUP cuando el canal de voz queda vacío */
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    if (oldState.channel && oldState.channel.members.filter(m => !m.user.bot).size === 0) {
      const vc = oldState.channel;
      const q = player.nodes.get(oldState.guild.id);
      if (!q) {
        voiceChannelCreators.delete(vc.id);
        channelPermittedUsers.delete(vc.id);
        voteSkips.delete(vc.id);
        channelHistory.delete(vc.id);
      } else {
        if (q.voiceChannel && q.voiceChannel.id === vc.id && (!q.tracks || q.tracks.size === 0)) {
          q.node.disconnect();
          q.delete();
          voiceChannelCreators.delete(vc.id);
          channelPermittedUsers.delete(vc.id);
          voteSkips.delete(vc.id);
          channelHistory.delete(vc.id);
        }
      }
    }
  } catch (e) { console.error('voiceStateUpdate cleanup err', e); }
});

/** LOGIN */
client.login(TOKEN).catch(err => {
  console.error('Error al iniciar sesión con el token:', err);
});
