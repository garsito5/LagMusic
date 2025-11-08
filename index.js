/**
 * index.js - SirgioMusicBOT (único archivo)
 *
 * Requisitos:
 * - .env con BOT_TOKEN, CLIENT_ID, GUILD_ID (GUILD_ID = 1212886282645147768)
 * - package.json con dependencias correctas (discord-player v6.7.1, @discord-player/extractor ^4.5.0, discord.js, @discordjs/voice, ffmpeg-static, dotenv, express, libsodium-wrappers)
 *
 * Nota: karaoke -> busca "query + karaoke" en la plataforma (la opción que elegiste).
 */

require('dotenv').config();
const express = require('express');
const http = require('http');

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } = require('discord.js');
const { Player, QueryType } = require('discord-player');
const play = require('play-dl');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || '1212886282645147768';

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Faltan variables en .env (BOT_TOKEN, CLIENT_ID, GUILD_ID)');
  process.exit(1);
}

/* -----------------------------
   Configuración: IDs permitidos
   ----------------------------- */
// Canales de texto permitidos donde también se puede usar comandos (además de requerir estar en VC para la mayoría)
const EXTRA_ALLOWED_TEXT_CHANNELS = new Set([
  '1222966360263626865',
  '1422809286417059850'
]);

/* -----------------------------
   Comandos a registrar (guild-local)
   ----------------------------- */
const rawCommands = [
  new SlashCommandBuilder().setName('play').setDescription('Reproducir canción o playlist')
    .addSubcommand(sc => sc.setName('song').setDescription('Reproducir una canción (nombre o url)').addStringOption(o => o.setName('query').setDescription('Nombre o URL').setRequired(true)))
    .addSubcommand(sc => sc.setName('playlist').setDescription('Reproducir una playlist (service + name/url)').addStringOption(o => o.setName('service').setDescription('Servicio (youtube/spotify/soundcloud)').setRequired(true)).addStringOption(o => o.setName('playlist_name').setDescription('Nombre o URL de la playlist').setRequired(true))),
  new SlashCommandBuilder().setName('skip').setDescription('Saltar la canción actual (owner o permitido)'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausar reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanudar reproducción'),
  new SlashCommandBuilder().setName('bucle').setDescription('Alternar bucle en la canción actual'),
  new SlashCommandBuilder().setName('any').setDescription('Reproducir cualquier Song de la cola (será la siguiente)'),
  new SlashCommandBuilder().setName('random').setDescription('Mezclar (shuffle) la cola'),
  new SlashCommandBuilder().setName('vote').setDescription('Sistema de votación')
    .addSubcommand(sc => sc.setName('skip').setDescription('Votar para saltar la canción actual')),
  new SlashCommandBuilder().setName('addpermiss').setDescription('El creador da permisos a otro usuario').addUserOption(o => o.setName('user').setDescription('Usuario a dar permisos').setRequired(true)),
  new SlashCommandBuilder().setName('clear').setDescription('Limpiar las siguientes Songs de la cola (solo creator)'),
  new SlashCommandBuilder().setName('karaoke').setDescription('Buscar y reproducir versión karaoke (instrumental)').addStringOption(o => o.setName('query').setDescription('Nombre o URL').setRequired(true)),
  new SlashCommandBuilder().setName('help').setDescription('Mostrar todos los comandos (embed)'),
].map(c => c.toJSON());

/* -----------------------------
   Cliente Discord + Player
   ----------------------------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ],
});

const player = new Player(client, {
  ytdlOptions: {
    quality: 'highestaudio',
    highWaterMark: 1 << 25
  }
});

// play-dl init (refresh token si aplica)
(async () => {
  try {
    if (await play.is_expired()) await play.refreshToken();
  } catch (e) {
    console.warn('[play-dl] init warning:', e?.message ?? e);
  }
})();

/* -----------------------------
   Helpers: embed y botones
   ----------------------------- */
function createNowPlayingEmbed(track) {
  return new EmbedBuilder()
    .setTitle('🎧 Now Playing')
    .setDescription(`[${track.title}](${track.url})`)
    .addFields(
      { name: 'Duration', value: track.duration ?? 'Unknown', inline: true },
      { name: 'Requested by', value: track.requestedBy?.tag ?? 'Unknown', inline: true },
      { name: 'Source', value: track.source ?? 'Unknown', inline: true }
    )
    .setThumbnail(track.thumbnail ?? null)
    .setColor('#00C2FF') // celeste suave
    .setFooter({ text: `Author: ${track.author ?? 'Unknown'}` });
}

function createControlButtons(queue) {
  const pauseBtn = new ButtonBuilder().setCustomId('music_pause').setLabel('⏯').setStyle(ButtonStyle.Primary);
  const skipBtn = new ButtonBuilder().setCustomId('music_skip').setLabel('⏭').setStyle(ButtonStyle.Secondary);
  const loopBtn = new ButtonBuilder().setCustomId('music_loop').setLabel('🔁').setStyle(ButtonStyle.Secondary);
  const shuffleBtn = new ButtonBuilder().setCustomId('music_shuffle').setLabel('🔀').setStyle(ButtonStyle.Secondary);
  const stopBtn = new ButtonBuilder().setCustomId('music_stop').setLabel('⏹').setStyle(ButtonStyle.Danger);

  // Si quieres, se puede mostrar el repeatMode en el label, pero mantenemos simple
  return new ActionRowBuilder().addComponents(pauseBtn, skipBtn, loopBtn, shuffleBtn, stopBtn);
}

/* -----------------------------
   Player events
   ----------------------------- */
player.on('trackStart', (queue, track) => {
  try {
    // enviar embed y botones al textChannel guardado en metadata
    if (queue.metadata?.textChannel) {
      queue.metadata.textChannel.send({ embeds: [createNowPlayingEmbed(track)], components: [createControlButtons(queue)] }).catch(() => {});
    }
    // reset votes al comenzar nueva canción
    if (queue.metadata) queue.metadata.voteSkips = new Set();
  } catch (e) {
    console.error('[player] trackStart err:', e);
  }
});

player.on('trackAdd', (queue, track) => {
  try {
    if (queue.metadata?.textChannel) {
      queue.metadata.textChannel.send({ content: `➕ Added to queue: **${track.title}** — requested by ${track.requestedBy?.tag ?? 'unknown'}` }).catch(() => {});
    }
  } catch (e) {}
});

player.on('queueEnd', (queue) => {
  try {
    if (queue.metadata?.textChannel) queue.metadata.textChannel.send('✅ Queue finished. Leaving voice channel.');
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
   Util: voice checks & metadata
   ----------------------------- */
function isChannelAllowed(interaction) {
  // Permitir si el comando se ejecuta en uno de los canales de texto permitidos
  if (EXTRA_ALLOWED_TEXT_CHANNELS.has(interaction.channelId)) return true;
  // Permitir si el usuario está en un canal de voz (desde ahí se ejecuta)
  if (interaction.member?.voice?.channel) return true;
  return false;
}

function checkVoiceRequirements(interaction) {
  // Usamos isChannelAllowed para permitir /help en canales especiales. Para la mayoría de comandos
  // exigiremos que el usuario esté en un VC (excepto /help que puede ejecutarse desde canales permitidos)
  const memberVC = interaction.member?.voice?.channel;
  if (!memberVC) return { ok: false, reply: 'You need to be in a voice channel to use this command.' };
  const botPerms = memberVC.permissionsFor(interaction.guild.members.me);
  if (!botPerms || !botPerms.has(PermissionsBitField.Flags.Connect) || !botPerms.has(PermissionsBitField.Flags.Speak)) {
    return { ok: false, reply: 'I need Connect and Speak permissions in your voice channel.' };
  }
  return { ok: true, channel: memberVC };
}

function ensureQueueMetadata(queue, textChannel) {
  if (!queue.metadata) queue.metadata = {};
  if (!queue.metadata.textChannel) queue.metadata.textChannel = textChannel;
  if (!queue.metadata.allowedIds) queue.metadata.allowedIds = new Set();
  if (!queue.metadata.voteSkips) queue.metadata.voteSkips = new Set();
  if (!queue.metadata.ownerId) queue.metadata.ownerId = null; // set when first play in session
}

/* -----------------------------
   Buttons handler (controls)
   ----------------------------- */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const queue = player.getQueue(interaction.guildId);
  if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });

  try {
    switch (interaction.customId) {
      case 'music_pause': {
        if (!queue.playing) return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
        const paused = queue.connection.paused;
        queue.setPaused(!paused);
        return interaction.reply({ content: paused ? '▶ Resumed' : '⏸ Paused', ephemeral: true });
      }
      case 'music_skip': {
        const uid = interaction.user.id;
        const isOwner = queue.metadata.ownerId === uid;
        const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(uid);
        if (!isOwner && !isAllowed) return interaction.reply({ content: 'You do not have permission to skip. Ask the creator to give you permission or use /vote skip.', ephemeral: true });
        await queue.skip();
        return interaction.reply({ content: '⏭ Skipped.', ephemeral: true });
      }
      case 'music_stop': {
        const uid = interaction.user.id;
        const isOwner = queue.metadata.ownerId === uid;
        const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(uid);
        if (!isOwner && !isAllowed) return interaction.reply({ content: 'You do not have permission to stop playback.', ephemeral: true });
        queue.destroy();
        return interaction.reply({ content: '⏹ Stopped and cleared queue.', ephemeral: true });
      }
      case 'music_shuffle': {
        queue.shuffle();
        return interaction.reply({ content: '🔀 Queue shuffled.', ephemeral: true });
      }
      case 'music_loop': {
        const newMode = queue.repeatMode === 1 ? 0 : 1;
        queue.setRepeatMode(newMode);
        return interaction.reply({ content: `🔁 Repeat: ${newMode === 0 ? 'off' : 'one'}.`, ephemeral: true });
      }
      default:
        return interaction.reply({ content: 'Unknown action.', ephemeral: true });
    }
  } catch (e) {
    console.error('button handler error:', e);
    if (!interaction.replied) await interaction.reply({ content: 'An error occurred with the control.', ephemeral: true });
  }
});

/* -----------------------------
   Slash commands handler
   ----------------------------- */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
    // ---------- HELP ----------
    if (cmd === 'help') {
      // allow only in allowed text channels or if user in VC
      if (!isChannelAllowed(interaction)) return interaction.reply({ content: 'Use this command in a voice channel or in the allowed channels.', ephemeral: true });

      const embed = new EmbedBuilder()
        .setTitle('SirgioMusicBOT - Command List')
        .setColor('#00C2FF') // celeste
        .setDescription('Commands list — use these in voice channels or the allowed text channels.\nStyle: gamer (we say "Song")')
        .addFields(
          { name: '/play song <query>', value: 'Plays a Song by name or URL. Adds to the queue if something is already playing.' },
          { name: '/play playlist <service> <playlist_name>', value: 'Searches and adds a playlist from the chosen service.' },
          { name: '/skip', value: 'Skip current Song (owner or permitted users). Others use /vote skip.' },
          { name: '/pause', value: 'Pause playback (owner or permitted users).' },
          { name: '/resume', value: 'Resume playback (owner or permitted users).' },
          { name: '/bucle', value: 'Toggle loop on the current Song.' },
          { name: '/any', value: 'Pick any random Song from the queue and play it next.' },
          { name: '/random', value: 'Shuffle the queue.' },
          { name: '/vote skip', value: 'Vote to skip the current Song. If more than half of humans in VC vote, it will skip.' },
          { name: '/addpermiss @user', value: 'Creator gives control permissions to another user (skip/pause/resume/stop).' },
          { name: '/clear', value: 'Clear next Songs in queue (creator only).' },
          { name: '/karaoke <query>', value: 'Search for "query karaoke" and play the first result (instrumental/Karaoke versions).' },
        )
        .setFooter({ text: 'SirgioMusicBOT — Have fun!' });

      return interaction.reply({ embeds: [embed] });
    }

    // For other commands enforce channel allowedness: must be in VC or in allowed text channels
    if (!isChannelAllowed(interaction)) return interaction.reply({ content: 'You must be in a voice channel to use music commands, or use the allowed text channels.', ephemeral: true });

    // ---------- PLAY ----------
    if (cmd === 'play') {
      const sub = interaction.options.getSubcommand();
      // if not in VC, check and connect
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      await interaction.deferReply();

      const queue = player.createQueue(interaction.guild, { metadata: { textChannel: interaction.channel }, leaveOnEmpty: true, leaveOnEnd: true });
      ensureQueueMetadata(queue, interaction.channel);

      try {
        if (!queue.connection) await queue.connect(check.channel);
      } catch (err) {
        queue.destroy();
        return interaction.editReply('Could not join your voice channel.');
      }

      if (!queue.metadata.ownerId) queue.metadata.ownerId = interaction.user.id;

      if (sub === 'song') {
        const query = interaction.options.getString('query', true);
        const search = await player.search(query, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
        if (!search || !search.tracks.length) return interaction.editReply(`❌ No results for \`${query}\`.`);

        const track = search.tracks[0];
        queue.addTrack(track);
        if (!queue.playing) await queue.play();
        return interaction.editReply({ content: `➕ Added to queue: **${track.title}**`, embeds: [createNowPlayingEmbed(track)], components: [createControlButtons(queue)] });
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
        if (!res || !res.tracks.length) return interaction.editReply(`❌ No playlist found for \`${playlistName}\` on ${service}.`);
        if (res.playlist) {
          queue.addTracks(res.tracks);
          if (!queue.playing) await queue.play();
          return interaction.editReply(`✅ Playlist added: **${res.playlist.title ?? playlistName}** — ${res.tracks.length} Songs.`);
        } else {
          queue.addTracks(res.tracks);
          if (!queue.playing) await queue.play();
          return interaction.editReply(`✅ Added ${res.tracks.length} Songs as playlist search results.`);
        }
      }
    }

    // ---------- SKIP ----------
    if (cmd === 'skip') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });

      const uid = interaction.user.id;
      const isOwner = queue.metadata.ownerId === uid;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(uid);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'You do not have permission to use /skip. Use /vote skip to request a skip.', ephemeral: true });

      await queue.skip();
      return interaction.reply({ content: '⏭ Skipped current Song.' });
    }

    // ---------- PAUSE ----------
    if (cmd === 'pause') {
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      const queue = player.getQueue(interaction.guildId);
      if (!queue || !queue.playing) return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });

      const uid = interaction.user.id;
      const isOwner = queue.metadata.ownerId === uid;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(uid);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'You do not have permission to pause.', ephemeral: true });

      queue.setPaused(true);
      return interaction.reply({ content: '⏸ Paused.' });
    }

    // ---------- RESUME ----------
    if (cmd === 'resume') {
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });

      const uid = interaction.user.id;
      const isOwner = queue.metadata.ownerId === uid;
      const isAllowed = queue.metadata.allowedIds && queue.metadata.allowedIds.has(uid);
      if (!isOwner && !isAllowed) return interaction.reply({ content: 'You do not have permission to resume.', ephemeral: true });

      queue.setPaused(false);
      return interaction.reply({ content: '▶ Resumed.' });
    }

    // ---------- BUCLE (loop current) ----------
    if (cmd === 'bucle') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });
      const currentMode = queue.repeatMode;
      const newMode = currentMode === 1 ? 0 : 1;
      queue.setRepeatMode(newMode);
      return interaction.reply({ content: `🔁 Repeat mode: ${newMode === 0 ? 'off' : 'one'}.` });
    }

    // ---------- ANY ----------
    if (cmd === 'any') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue || !queue.playing) return interaction.reply({ content: 'No active queue.', ephemeral: true });
      if (!queue.tracks.length) return interaction.reply({ content: 'No more Songs in queue.', ephemeral: true });
      const idx = Math.floor(Math.random() * queue.tracks.length);
      const track = queue.tracks.splice(idx, 1)[0];
      queue.insertTrack(0, track);
      return interaction.reply({ content: `🎲 Any Song selected: **${track.title}** — will play next.` });
    }

    // ---------- RANDOM (shuffle) ----------
    if (cmd === 'random') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });
      queue.shuffle();
      return interaction.reply({ content: '🔀 Queue shuffled.' });
    }

    // ---------- VOTE SKIP ----------
    if (cmd === 'vote') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'skip') {
        const queue = player.getQueue(interaction.guildId);
        if (!queue || !queue.playing) return interaction.reply({ content: 'No active Song to vote on.', ephemeral: true });

        const uid = interaction.user.id;
        const isOwner = queue.metadata.ownerId === uid;
        if (isOwner) { await queue.skip(); return interaction.reply({ content: 'You are the creator — Song skipped.' }); }

        const vc = interaction.member.voice.channel;
        if (!vc) return interaction.reply({ content: 'You must be in the same voice channel to vote.', ephemeral: true });

        ensureQueueMetadata(queue, interaction.channel);
        const voters = queue.metadata.voteSkips || new Set();
        if (voters.has(uid)) return interaction.reply({ content: 'You already voted to skip this Song.', ephemeral: true });
        voters.add(uid);
        queue.metadata.voteSkips = voters;

        // majority > 50% of human members in VC
        const humans = vc.members.filter(m => !m.user.bot);
        const needed = Math.floor(humans.size / 2) + 1;
        const votes = voters.size;

        if (votes >= needed) {
          await queue.skip();
          queue.metadata.voteSkips = new Set();
          return interaction.reply({ content: `✅ Votes sufficient (${votes}/${humans.size}). Song skipped.` });
        } else {
          return interaction.reply({ content: `🗳 Vote registered (${votes}/${needed}). Need ${needed} votes (humans in VC: ${humans.size}).` });
        }
      }
    }

    // ---------- ADD PERMISS ----------
    if (cmd === 'addpermiss') {
      const target = interaction.options.getUser('user', true);
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });
      if (queue.metadata.ownerId !== interaction.user.id) return interaction.reply({ content: 'Only the creator can grant permissions.', ephemeral: true });

      ensureQueueMetadata(queue, interaction.channel);
      queue.metadata.allowedIds.add(target.id);
      return interaction.reply({ content: `✅ ${target.tag} now has control permissions for this session.` });
    }

    // ---------- CLEAR ----------
    if (cmd === 'clear') {
      const queue = player.getQueue(interaction.guildId);
      if (!queue) return interaction.reply({ content: 'No active queue.', ephemeral: true });
      if (queue.metadata.ownerId !== interaction.user.id) return interaction.reply({ content: 'Only the creator can clear the queue.', ephemeral: true });

      queue.clear();
      return interaction.reply({ content: '🧹 Queue cleared (next Songs removed).' });
    }

    // ---------- KARAOKE ----------
    if (cmd === 'karaoke') {
      const query = interaction.options.getString('query', true);
      const check = checkVoiceRequirements(interaction);
      if (!check.ok) return interaction.reply({ content: check.reply, ephemeral: true });

      await interaction.deferReply();

      const queue = player.createQueue(interaction.guild, { metadata: { textChannel: interaction.channel }, leaveOnEmpty: true, leaveOnEnd: true });
      ensureQueueMetadata(queue, interaction.channel);
      try { if (!queue.connection) await queue.connect(check.channel); } catch (e) { queue.destroy(); return interaction.editReply('Could not join your voice channel.'); }

      if (!queue.metadata.ownerId) queue.metadata.ownerId = interaction.user.id;

      // Buscar versión karaoke agregando "karaoke"
      const kquery = `${query} karaoke`;
      const res = await player.search(kquery, { requestedBy: interaction.user, searchEngine: QueryType.AUTO });
      if (!res || !res.tracks.length) return interaction.editReply(`❌ No karaoke version found for \`${query}\`.`);

      const track = res.tracks[0];
      queue.addTrack(track);
      if (!queue.playing) await queue.play();
      return interaction.editReply({ content: `🎤 Karaoke added: **${track.title}**`, embeds: [createNowPlayingEmbed(track)] });
    }

  } catch (err) {
    console.error('[cmd] error:', err);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'An error occurred running the command.' });
      else await interaction.reply({ content: 'An error occurred running the command.', ephemeral: true });
    } catch (e) { console.error(e); }
  }
});

/* -----------------------------
   Register guild commands on startup (local registration)
   ----------------------------- */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // register commands for the GUILD_ID specified (local)
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: rawCommands });
    console.log('Local guild commands registered for', GUILD_ID);
  } catch (err) {
    console.error('Error registering guild commands:', err);
  }
});

/* -----------------------------
   Minimal express to keep alive (optional)
   ----------------------------- */
const app = express();
app.get('/', (req, res) => res.send('SirgioMusicBOT alive.'));
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Express server listening on ${PORT}`));

/* -----------------------------
   Login
   ----------------------------- */
client.login(TOKEN);
