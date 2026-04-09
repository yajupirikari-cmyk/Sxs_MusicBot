const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// ★ これが無いと無音になるFFmpeg強制指定
// ==========================================
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('Discord Music Bot is Online & Uncrashable!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();

// ==========================================
// ★ 最重要：Botの自爆ループを防ぐ完全防御システム
// ==========================================
client.on('error', error => console.error('Discord Client Error:', error));
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));

const commands = [
    new SlashCommandBuilder().setName('join').setDescription('ボイスチャンネルにBotを参加させます'),
    new SlashCommandBuilder().setName('leave').setDescription('再生を終了し退出させます'),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('音楽を再生またはキューに追加します')
        .addStringOption(opt => opt.setName('query').setDescription('曲名またはURL').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('曲をスキップします'),
    new SlashCommandBuilder().setName('queue').setDescription('キューを表示します'),
    new SlashCommandBuilder().setName('pause').setDescription('一時停止します'),
    new SlashCommandBuilder().setName('resume').setDescription('再開します')
];

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    if (process.env.YOUTUBE_COOKIE) {
        try {
            await play.setToken({ youtube: { cookie: JSON.parse(process.env.YOUTUBE_COOKIE) } });
            console.log('クッキー読込完了');
        } catch (e) {}
    }
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try { await rest.put(Routes.applicationCommands(client.user.id), { body: commands }); } catch (e) {}
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, options, guild } = interaction;
    const voiceChannel = interaction.member.voice.channel;
    let serverQueue = queues.get(guildId);

    try {
        if (commandName === 'join') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに参加してください！', ephemeral: true }).catch(() => {});
            joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
            return interaction.reply('🔊 ボイスチャンネルに参加しました！').catch(() => {});
        }

        if (commandName === 'leave') {
            const connection = getVoiceConnection(guildId);
            if (!connection) return interaction.reply('Botは参加していません。').catch(() => {});
            if (serverQueue) { serverQueue.songs = []; serverQueue.player.stop(); queues.delete(guildId); }
            connection.destroy();
            return interaction.reply('👋 退出しました。').catch(() => {});
        }

        if (commandName === 'play') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに入ってください！', ephemeral: true }).catch(() => {});
            
            // 3秒ルールのタイムアウトを回避するため、即座に「考え中...」状態にする
            await interaction.deferReply().catch(() => {});

            const query = options.getString('query');
            const ytInfo = await play.search(query, { limit: 1 });
            if (!ytInfo.length) return interaction.editReply('動画が見つかりませんでした。').catch(() => {});

            const originalTitle = ytInfo[0].title;
            let finalUrl = ytInfo[0].url;

            try {
                if (finalUrl.includes('youtube.com') || finalUrl.includes('youtu.be')) {
                    const scClientId = await play.getFreeClientID();
                    await play.setToken({ soundcloud: { client_id: scClientId } });
                    const scInfo = await play.search(originalTitle, { source: { soundcloud: 'tracks' }, limit: 1 });
                    if (scInfo && scInfo.length > 0) finalUrl = scInfo[0].url;
                }
            } catch (err) {}

            const song = { title: originalTitle, url: finalUrl, duration: ytInfo[0].durationRaw };

            if (!serverQueue) {
                const queueConstruct = {
                    textChannel: interaction.channel,
                    voiceChannel,
                    connection: joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true }),
                    songs: [song],
                    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
                };
                queues.set(guildId, queueConstruct);
                queueConstruct.connection.subscribe(queueConstruct.player);

                queueConstruct.player.on('error', error => {
                    queueConstruct.textChannel.send(`⚠️ エラー発生: ${error.message}`).catch(() => {});
                    queueConstruct.songs.shift();
                    if (queueConstruct.songs.length > 0) playSong(guild, queueConstruct.songs[0]);
                });

                queueConstruct.player.on(AudioPlayerStatus.Idle, () => {
                    queueConstruct.songs.shift();
                    if (queueConstruct.songs.length > 0) playSong(guild, queueConstruct.songs[0]);
                });

                playSong(guild, queueConstruct.songs[0]);
                return interaction.editReply(`▶️ **${song.title}** を再生します！`).catch(() => {});
            } else {
                serverQueue.songs.push(song);
                return interaction.editReply(`📝 **${song.title}** をキューに追加しました。`).catch(() => {});
            }
        }

        if (commandName === 'skip') {
            if (!serverQueue) return interaction.reply('スキップする曲がありません。').catch(() => {});
            serverQueue.player.stop();
            return interaction.reply('⏭️ スキップしました。').catch(() => {});
        }

        if (commandName === 'queue') {
            if (!serverQueue || serverQueue.songs.length === 0) return interaction.reply('キューは空です。').catch(() => {});
            const list = serverQueue.songs.slice(0, 5).map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`).join('\n');
            return interaction.reply(`**現在のキュー:**\n${list}\n全${serverQueue.songs.length}曲`).catch(() => {});
        }

        if (commandName === 'pause') {
            if (!serverQueue) return interaction.reply('再生中ではありません。').catch(() => {});
            serverQueue.player.pause();
            return interaction.reply('⏸️ 一時停止しました。').catch(() => {});
        }

        if (commandName === 'resume') {
            if (!serverQueue) return interaction.reply('曲がありません。').catch(() => {});
            serverQueue.player.unpause();
            return interaction.reply('▶️ 再開します。').catch(() => {});
        }

    } catch (e) {
        console.error(e);
        if (interaction.deferred) interaction.editReply('❌ エラーが発生しました。').catch(()=>false);
    }
});

async function playSong(guild, song) {
    const serverQueue = queues.get(guild.id);
    if (!song) return;

    try {
        const stream = await play.stream(song.url, { discordPlayerCompatibility: true });
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);
        
    } catch (error) {
        console.error(error);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ 再生処理に失敗しました。次の曲へスキップします...`).catch(()=>{});
        serverQueue.songs.shift();
        if (serverQueue.songs.length > 0) playSong(guild, serverQueue.songs[0]);
    }
}

client.login(process.env.DISCORD_TOKEN);
