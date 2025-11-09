// index.js
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  PermissionsBitField,
  EmbedBuilder,
  InteractionResponseFlags
} = require('discord.js');
const express = require('express');
const { Player, QueryType, QueueRepeatMode } = require('discord-player');

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN) {
  console.error('Por favor define TOKEN en .env');
  process.exit(1);
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
 * --- Registro automático de comandos ---
 */
client.once('ready', async () => {
  console.log(`✅ Bot iniciado como ${client.user.tag}`);

  const commands = [
    {
      name: 'play',
      description: 'Reproduce una canción o playlist',
      options: [
        {
          name: 'query',
          type: 3,
          description: 'Nombre o enlace de la canción',
          required: true
        }
      ]
    },
    {
      name: 'skip',
      description: 'Salta a la siguiente canción'
    },
    {
      name: 'pause',
      description: 'Pausa la reproducción actual'
    },
    {
      name: 'resume',
      description: 'Reanuda la reproducción'
    },
    {
      name: 'stop',
      description: 'Detiene y limpia la cola de música'
    },
    {
      name: 'queue',
      description: 'Muestra las canciones en la cola'
    },
    {
      name: 'help',
      description: 'Muestra información sobre los comandos disponibles'
    }
  ];

  await client.application.commands.set(commands);
  console.log('✅ Comandos registrados globalmente');
});

/**
 * --- Manejo de comandos slash ---
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // Asegura que el usuario esté en un canal de voz
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (commandName === 'play') {
    const query = interaction.options.getString('query');

    if (!voiceChannel)
      return interaction.reply({
        content: '❌ Debes estar en un canal de voz para usar este comando.',
        flags: InteractionResponseFlags.Ephemeral
      });

    const queue = player.nodes.create(interaction.guild, {
      metadata: { channel: interaction.channel }
    });

    if (!queue.connection)
      await queue.connect(voiceChannel);

    const result = await player.search(query, {
      requestedBy: interaction.user,
      searchEngine: QueryType.AUTO
    });

    if (!result || !result.tracks.length)
      return interaction.reply({
        content: '❌ No se encontraron resultados.',
        flags: InteractionResponseFlags.Ephemeral
      });

    queue.addTrack(result.tracks[0]);
    if (!queue.isPlaying()) await queue.node.play();

    return interaction.reply({
      content: `🎶 Reproduciendo **${result.tracks[0].title}**`,
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'skip') {
    const queue = player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying())
      return interaction.reply({
        content: '❌ No hay canciones reproduciéndose.',
        flags: InteractionResponseFlags.Ephemeral
      });

    queue.node.skip();
    return interaction.reply({
      content: '⏭️ Canción saltada.',
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'pause') {
    const queue = player.nodes.get(interaction.guildId);
    if (!queue || !queue.isPlaying())
      return interaction.reply({
        content: '❌ No hay canciones reproduciéndose.',
        flags: InteractionResponseFlags.Ephemeral
      });

    queue.node.pause();
    return interaction.reply({
      content: '⏸️ Canción pausada.',
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'resume') {
    const queue = player.nodes.get(interaction.guildId);
    if (!queue)
      return interaction.reply({
        content: '❌ No hay música en la cola.',
        flags: InteractionResponseFlags.Ephemeral
      });

    queue.node.resume();
    return interaction.reply({
      content: '▶️ Canción reanudada.',
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'stop') {
    const queue = player.nodes.get(interaction.guildId);
    if (!queue)
      return interaction.reply({
        content: '❌ No hay música en reproducción.',
        flags: InteractionResponseFlags.Ephemeral
      });

    queue.delete();
    return interaction.reply({
      content: '⏹️ Música detenida y cola vaciada.',
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'queue') {
    const queue = player.nodes.get(interaction.guildId);
    if (!queue || !queue.tracks.toArray().length)
      return interaction.reply({
        content: '📭 No hay canciones en la cola.',
        flags: InteractionResponseFlags.Ephemeral
      });

    const tracks = queue.tracks
      .toArray()
      .slice(0, 10)
      .map((t, i) => `${i + 1}. **${t.title}** — ${t.author}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setColor(HELP_COLOR)
      .setTitle('🎵 Cola actual')
      .setDescription(tracks);

    return interaction.reply({
      embeds: [embed],
      flags: InteractionResponseFlags.Ephemeral
    });
  }

  if (commandName === 'help') {
    if (
      !HELP_CHANNEL_IDS.includes(interaction.channelId) &&
      !voiceChannel
    ) {
      return interaction.reply({
        content:
          '❌ Solo puedes usar `/help` en los canales de voz o en los canales designados.',
        flags: InteractionResponseFlags.Ephemeral
      });
    }

    const embed = new EmbedBuilder()
      .setColor(HELP_COLOR)
      .setTitle('🎶 Lista de Comandos - Sirgio Music Bot')
      .setDescription(
        [
          '**/play [canción]** → Reproduce una canción o playlist.',
          '**/skip** → Salta a la siguiente canción.',
          '**/pause** → Pausa la música actual.',
          '**/resume** → Reanuda la reproducción.',
          '**/stop** → Detiene la música y limpia la cola.',
          '**/queue** → Muestra las canciones en la cola.',
          '**/help** → Muestra este mensaje.'
        ].join('\n')
      )
      .setFooter({ text: 'Sirgio Music Bot | 🎧 Música sin interrupciones' });

    return interaction.reply({
      embeds: [embed],
      flags: InteractionResponseFlags.Ephemeral
    });
  }
});

/**
 * --- Servidor Express para mantener activo en Render ---
 */
const app = express();
app.get('/', (req, res) => res.send('Sirgio Music Bot está vivo 🎵'));
app.listen(3000, () => console.log('🌐 Servidor web activo en puerto 3000'));

/**
 * --- Login ---
 */
client.login(TOKEN);
