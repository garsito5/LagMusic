// index.js - SirgioMusicBOT (todo en un solo archivo)
// Requisitos: .env con BOT_TOKEN, CLIENT_ID, (opcional) GUILD_ID
// npm install según package.json

require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const play = require('play-dl');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('Falta BOT_TOKEN o CLIENT_ID en .env');
  process.exit(1);
}

/* -----------------------------
   Definición de comandos (registro)
   ----------------------------- */
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Reproducir canción o playlist')
    .addSubcommand(sc => sc.setName('song').setDescription('Reproducir una canción (nombre o url)').addStringOption(o => o.setName('query').setDescription('Nombre o URL').setRequired(true)))
    .addSubcommand(sc => sc.setName('playlist').setDescription('Reproducir una playlist').addStringOption(o => o.setName('service').setDescription('Servicio (youtube/spotify/soundcloud)').setRequired(true)).addStringOption(o => o.setName('playlist_name').setDescription('Nombre o URL de la playlist').setRequired(true))),
  new SlashCommandBuilder().setName('skip').setDescription('Saltar la canción actual (owner o permitido)'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausar reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanudar reproducción'),
  new SlashCommandBuilder().setName('bucle').setDescription('Alternar bucle en la canción actual'),
  new SlashCommandBuilder().setName('any').setDescription('Reproducir cualquier canción de la cola (será la siguiente)'),
  new SlashCommandBuilder().setName('random').setDescription('Mezclar la cola'),
  new SlashCommandBuilder().setName('vote').setDescription('Sistema de votación').addSubcommand(sc => sc.setName('skip').setDescription('Votar para saltar la canción actual')),
  new SlashCommandBuilder().setName('addpermiss').setDescription('El creador da permisos a otro usuario').addUserOption(o => o.setName('user').setDescription('Usuario a dar permisos').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Limpiar las siguientes canciones (solo creator)'),
  new SlashCommandBuilder().setName('karaoke').setDescription('Reproducir versión karaoke (instrumental)').addStringOption(o => o.setName('query').setDescription('Nombre o URL').setRequired(true)),
].map(cmd => cmd.toJSON());

/* -----------------------------
   Cliente y player
   ----------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ]
});

const player = new Player(client, {
  ytdlOptions: { quality: 'highestaudio', highWaterMark: 1 << 25 }
});

/* Inicializar play-dl (refresh token si hace falta) */
(async () => {
  try {
    if (await play.is_expired()) await play.refreshToken();
  } catch (e) {
    console.warn('play-dl init warning:', e?.message ?? e);
  }
})();

/* -----------------------------
   Helpers: embeds + botones
   ----------------------------- */
function createNowPlayingEmbed(track) {
  return new EmbedBuilder()
    .setTitle('🎶 Ahora sonando')
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duración', value: track.duration ?? 'Desconocida', inline: true },
      { name: 'Solicitado por', value: track.requestedBy?.tag ?? 'Desconocido', inline: true },
      { name: 'Fuente', value: track.source ?? 'Desconocida', inline: true }
    )
    .setThumbnail(track.thumbnail ?? null)
    .setFooter({ text: `Author: ${track.author ?? 'Desconocido'}` });
}

function createControlButtons() {
  const pauseBtn = new ButtonBuilder().setCustomId('music_pause').setLabel('⏯').setStyle(ButtonStyle.Primary);
  const skipBtn = new ButtonBuilder().setCustomId('music_skip').setLabel('⏭').setStyle(ButtonStyle.Secondary);
  const loopBtn = new ButtonBuilder().setCustomId('music_loop').setLabel('🔁').setStyle(ButtonStyle.Secondary);
  const shuffleBtn = new ButtonBuilder().setCustomId('music_shuffle').setLabel('🔀').setStyle(ButtonStyle.Secondary);
  const stopBtn = new ButtonBuilder().setCustomId('music_stop').setLabel('⏹').setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(pauseBtn, skipBtn, loopBtn, shuffleBtn, stopBtn);
  return row;
}

/* -----------------------------
   Eventos del player
   ----------------------------- */
player.on('trackStart', (queue, track) => {
  try {
    // enviar embed en el textChannel metadata (si existe)
    if (queue.metadata?.textChannel) {
      queue.metadata.textChannel.send({ embeds: [createNowPlayingEmbed(track)], components: [createControlButtons()] }).catch(() => {});
    }
    // resetear votos para la nueva pista
    if (queue.metadata) queue.metadata.voteSkips = new Set();
  } catch (e) {
    console.error('trackStart err:', e);
  }
});

player.on('trackAdd', (queue, track) => {
  try {
    if (queue.metadata?.textChannel) {
      queue.metadata.textChannel.send({ content: `➕ Añadida a la cola: **${track.title}** — solicitado por ${track.requestedBy?.tag ?? 'desconocido'}` }).catch(() => {});
    }
  } catch (e) {}
});

player.on('queueEnd', (queue) => {
  try {
    if (queue.metadata?.textChannel) queue.metadata.textChannel.send('✅ Cola finalizada. Me desconecto.');
    queue?.destroy?.();
  } catch (e) {}
});

player.on('error', (queue, error) => {
  console.error('[player error]', error);
});

player.on('connectionError', (queue, error) => {
  console.error('[connectionError]', error);
});

/* -----------------------------
   Util: requisitos de voz y metadata
   ----------------------------- */
function checkVoiceRequirements(interaction) {
  const memberVC = interaction.member?.voice?.channel;
  if (!memberVC) return { ok: false, reply: 'Necesitas estar en un canal de voz para usar comandos de música.' };
  const botPerms = memberVC.permissionsFor(interaction.guild.members.me);
  if (!botPerms || !botPerms.has(PermissionsBitField.Flags.Connect) || !botPerms.has(PermissionsBitField.Flags.Speak)) {
    return { ok: false, reply: 'No tengo permisos para conectarme o hablar en tu canal de voz. Revisa Connect / Speak.' };
  }
  return { ok: true, channel: memberVC };
}

function ensureQueueMetadata(queue, textChannel) {
  if (!queue.metadata) queue.metadata = {};
  if (!queue.metadata.textChannel) queue.metadata.textChannel = textChannel;
  if (!queue.metadata.allowedIds) queue.metadata.allowedIds = new Set();
  if (!queue.metadata.voteSkips) queue.metadata.voteSkips = new Set();
  if (!queue.metadata.ownerId) queue.metadata.ownerId = null;
}

/* -----------------------------
   Botones (interacciones)
   ----------------------------- */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const queue = player.getQueue(interaction.guildId);
  if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

  try {
    switch (interaction.customId) {
      case 'music_pause': {
        if (!queue.playing) return interaction.reply({ content: 'No se está reproduciendo nada.', ephemeral: true });
        const paused = queue.connection.paused;
        queue.setPaused(!paused);
        return interaction.reply({ content: paused ? '▶ Reanudado' : '⏸ Pausado', ephemeral: true });
      }
      case 'music_skip': {
        const userId = interaction.user.id;
        const isOwner = queue.metadata.ownerId === userId;
        const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(userId);
        if (!isOwner && !isAllowed) return interaction.reply({ content: 'No tienes permisos para usar skip. Pide al creador que te dé permisos o usen /vote skip.', ephemeral: true });
        await queue.skip();
        return interaction.reply({ content: '⏭ Canción saltada.', ephemeral: true });
      }
      case 'music_stop': {
        const userId = interaction.user.id;
        const isOwner = queue.metadata.ownerId === userId;
        const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(userId);
        if (!isOwner && !isAllowed) return interaction.reply({ content: 'No tienes permisos para detener la reproducción.', ephemeral: true });
        queue.destroy();
        return interaction.reply({ content: '⏹ Reproducción detenida y cola limpiada.', ephemeral: true });
      }
      case 'music_shuffle': {
        queue.shuffle();
        return interaction.reply({ content: '🔀 Cola mezclada.', ephemeral: true });
      }
      case 'music_loop': {
        const mode = queue.repeatMode === 1 ? 0 : 1;
        queue.setRepeatMode(mode);
        return interaction.reply({ content: `🔁 Modo repetición: ${mode === 0 ? 'off' : 'one'}.`, ephemeral: true });
      }
      default:
        return interaction.reply({ content: 'Acción desconocida.', ephemeral: true });
    }
  } catch (e) {
    console.error('button handle error:', e);
    if (!interaction.replied) await interaction.reply({ content: 'Ocurrió un error con el control.', ephemeral: true });
  }
});

/* -----------------------------
   Comandos slash (todo en uno)
   ----------------------------- */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
    // ---------- /play ----------
    if (cmd === 'play') {
      const sub = interaction.options.getSubcommand();
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      await interaction.deferReply();

      // create/obtain queue
      const queue = player.createQueue(interaction.guild, { metadata: { textChannel: interaction.channel }, leaveOnEmpty: true, leaveOnEnd: true });
      ensureQueueMetadata(queue, interaction.channel);

      // connect to VC if needed
      try {
        if (!queue.connection) await queue.connect(check.channel);
      } catch (err) {
        queue.destroy();
        return interaction.editReply('No pude conectar al canal de voz.');
      }

      // set ownerId if not set (quien inició la reproducción en la sesión)
      if (!queue.metadata.ownerId) queue.metadata.ownerId = interaction.user.id;

      if (sub === 'song') {
        const query = interaction.options.getString('query', true);
        const result = await player.search(query, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
        if (!result || !result.tracks.length) return interaction.editReply(`❌ No encontré resultados para \`${query}\`.`);

        const track = result.tracks[0];
        queue.addTrack(track);
        if (!queue.playing) await queue.play();
        const embed = createNowPlayingEmbed(track);
        return interaction.editReply({ content: `➕ Añadida a la cola: **${track.title}**`, embeds: [embed], components: [createControlButtons()] });
      }

      if (sub === 'playlist') {
        const service = interaction.options.getString('service', true).toLowerCase();
        const playlistName = interaction.options.getString('playlist_name', true);
        let query = playlistName;
        if (!playlistName.startsWith('http')) {
          if (service.includes('spotify')) query = `${playlistName} playlist spotify`;
          else if (service.includes('youtube') || service.includes('yt')) query = `${playlistName} playlist youtube`;
          else if (service.includes('soundcloud')) query = `${playlistName} playlist soundcloud`;
        }
        const res = await player.search(query, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
        if (!res || !res.tracks.length) return interaction.editReply(`❌ No encontré la playlist \`${playlistName}\` en ${service}.`);

        if (res.playlist) {
          queue.addTracks(res.tracks);
          if (!queue.playing) await queue.play();
          return interaction.editReply(`✅ Playlist añadida: **${res.playlist.title ?? playlistName}** — ${res.tracks.length} canciones.`);
        } else {
          queue.addTracks(res.tracks);
          if (!queue.playing) await queue.play();
          return interaction.editReply(`✅ Añadidas ${res.tracks.length} canciones encontradas como playlist.`);
        }
      }
    }

    // ---------- /skip ----------
    if (cmd === 'skip') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

      const userId = interaction.user.id;
      const isOwner = queue.metadata.ownerId === userId;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(userId);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'No tienes permisos para usar /skip. Usa /vote skip.', ephemeral: true });

      await queue.skip();
      return interaction.reply({ content: '⏭ Canción saltada.' });
    }

    // ---------- /pause ----------
    if (cmd === 'pause') {
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });
      const queue = player.getQueue(interaction.guildId);
      if (!queue || !queue.playing) return interaction.reply({ content: 'No hay reproducción activa.', ephemeral: true });

      const userId = interaction.user.id;
      const isOwner = queue.metadata.ownerId === userId;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(userId);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'No tienes permiso para pausar.', ephemeral: true });

      queue.setPaused(true);
      return interaction.reply({ content: '⏸ Reproducción pausada.' });
    }

    // ---------- /resume ----------
    if (cmd === 'resume') {
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });

      const userId = interaction.user.id;
      const isOwner = queue.metadata.ownerId === userId;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(userId);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'No tienes permiso para reanudar.', ephemeral: true });

      queue.setPaused(false);
      return interaction.reply({ content: '▶ Reproducción reanudada.' });
    }

    // ---------- /bucle ----------
    if (cmd === 'bucle') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });
      const currentMode = queue.repeatMode;
      const newMode = currentMode === 1 ? 0 : 1;
      queue.setRepeatMode(newMode);
      return interaction.reply({ content: `🔁 Modo repetición: ${newMode === 0 ? 'off' : 'one'}.` });
    }

    // ---------- /any ----------
    if (cmd === 'any') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue || !queue.playing) return interaction.reply({ content: 'No hay playlist/cola activa.', ephemeral: true });
      if (!queue.tracks.length) return interaction.reply({ content: 'No hay más canciones en la cola.', ephemeral: true });
      const randomIndex = Math.floor(Math.random() * queue.tracks.length);
      const track = queue.tracks.splice(randomIndex, 1)[0];
      queue.insertTrack(0, track);
      return interaction.reply({ content: `🎲 Reproduciendo cualquier canción: **${track.title}** (será la siguiente).` });
    }

    // ---------- /random ----------
    if (cmd === 'random') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });
      queue.shuffle();
      return interaction.reply({ content: '🔀 Cola mezclada.' });
    }

    // ---------- /vote skip ----------
    if (cmd === 'vote') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'skip') {
        const queue = player.getQueue(interaction.guildId);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No hay reproducción activa.', ephemeral: true });

        const userId = interaction.user.id;
        const isOwner = queue.metadata.ownerId === userId;
        if (isOwner) {
          await queue.skip();
          return interaction.reply({ content: 'Eres el creador, salté la canción.' });
        }

        const vc = interaction.member.voice.channel;
        if (!vc) return interaction.reply({ content: 'Debes estar en el mismo canal de voz para votar.', ephemeral: true });

        ensureQueueMetadata(queue, interaction.channel);
        const voters = queue.metadata.voteSkips || new Set();
        if (voters.has(userId)) return interaction.reply({ content: 'Ya votaste para saltar esta canción.', ephemeral: true });
        voters.add(userId);
        queue.metadata.voteSkips = voters;

        const members = vc.members.filter(m => !m.user.bot);
        const needed = Math.floor(members.size / 2) + 1;
        const votes = voters.size;

        if (votes >= needed) {
          await queue.skip();
          queue.metadata.voteSkips = new Set();
          return interaction.reply({ content: `✅ Votos suficientes (${votes}/${members.size}). Canción saltada.` });
        } else {
          return interaction.reply({ content: `🗳 Voto registrado (${votes}/${needed}). Se necesitan ${needed} votos (miembros humanos en el VC: ${members.size}).` });
        }
      }
    }

    // ---------- /addpermiss ----------
    if (cmd === 'addpermiss') {
      const target = interaction.options.getUser('user', true);
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });
      if (queue.metadata.ownerId !== interaction.user.id) return interaction.reply({ content: 'Solo el creador puede dar permisos.', ephemeral: true });

      ensureQueueMetadata(queue, interaction.channel);
      queue.metadata.allowedIds.add(target.id);
      return interaction.reply({ content: `✅ ${target.tag} ahora tiene permisos para controlar la reproducción en esta sesión.` });
    }

    // ---------- /clear ----------
    if (cmd === 'clear') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No hay cola activa.', ephemeral: true });
      if (queue.metadata.ownerId !== interaction.user.id) return interaction.reply({ content: 'Solo el creador puede limpiar la cola.', ephemeral: true });

      queue.clear();
      return interaction.reply({ content: '🧹 Cola limpiada (se detuvieron las siguientes canciones).' });
    }

    // ---------- /karaoke ----------
    if (cmd === 'karaoke') {
      const query = interaction.options.getString('query', true);
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      await interaction.deferReply();
      const queue = player.createQueue(interaction.guild, { metadata: { textChannel: interaction.channel } });
      ensureQueueMetadata(queue, interaction.channel);
      try { if (!queue.connection) await queue.connect(check.channel); } catch (e) { queue.destroy(); return interaction.editReply('No pude conectar al canal de voz.'); }

      if (!queue.metadata.ownerId) queue.metadata.ownerId = interaction.user.id;

      const kquery = `${query} karaoke instrumental karaoke version`;
      const res = await player.search(kquery, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
      if (!res || !res.tracks.length) return interaction.editReply(`❌ No encontré versión karaoke de \`${query}\`.`);

      const track = res.tracks[0];
      queue.addTrack(track);
      if (!queue.playing) await queue.play();
      return interaction.editReply({ content: `🎤 Añadida versión karaoke: **${track.title}**`, embeds: [createNowPlayingEmbed(track)] });
    }

  } catch (err) {
    console.error('Comando error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Ocurrió un error al ejecutar el comando.' });
      else await interaction.reply({ content: 'Ocurrió un error al ejecutar el comando.', ephemeral: true });
    } catch (e) { console.error(e); }
  }
});

/* -----------------------------
   Registrar comandos (ready)
   ----------------------------- */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Registrar comandos (guild-scoped si GUILD_ID dado, si no global)
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Comandos registrados en GUILD:', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Comandos registrados globalmente (tarda en propagarse).');
    }
  } catch (err) {
    console.error('Error registrando comandos:', err);
  }
});

client.login(TOKEN);
