const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// ★ 無音バグ修正パッチ (FFmpegの位置を強制指定)
// ==========================================
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

// ==========================================
// 1. ダミーWebサーバー (稼働維持用)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('Discord Music Bot 24/7 is Online!'));
app.listen(port, () => console.log(`Web server listening on port ${port}`));

// ==========================================
// 2. Discord 音楽Bot ロジック
// ==========================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const queues = new Map();

// --- コマンド定義 ---
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
    new SlashCommandBuilder().setName('resume').setDescription('再開します'),
    new SlashCommandBuilder()
        .setName('setcookie')
        .setDescription('入力フォームを開いてYouTubeのクッキーJSONを登録します')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Renderの環境変数からクッキーを読み込む（設定済みならここが動きます）
    if (process.env.YOUTUBE_COOKIE) {
        try {
            await play.setToken({ youtube: { cookie: JSON.parse(process.env.YOUTUBE_COOKIE) } });
            console.log('環境変数から初期クッキーを正常にロードしました');
        } catch (e) {
            console.log('クッキーのロードに失敗しました');
        }
    }

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered.');
    } catch (e) {
        console.error(e);
    }
});

// --- インタラクション処理 ---
client.on('interactionCreate', async interaction => {
    
    // モーダル(フォーム)送信時の処理
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'cookieModal') {
            const jsonStr = interaction.fields.getTextInputValue('cookieInput');
            try {
                const cookieObj = JSON.parse(jsonStr);
                await play.setToken({ youtube: { cookie: cookieObj } });
                return interaction.reply({ content: '✅ クッキーを正常に登録しました！', ephemeral: true });
            } catch (err) {
                console.error(err);
                return interaction.reply({ content: '❌ JSONの形式が正しくありません。', ephemeral: true });
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, options, guild } = interaction;
    const voiceChannel = interaction.member.voice.channel;
    let serverQueue = queues.get(guildId);

    try {
        if (commandName === 'setcookie') {
            const modal = new ModalBuilder().setCustomId('cookieModal').setTitle('YouTube Cookie 登録');
            const cookieInput = new TextInputBuilder().setCustomId('cookieInput').setLabel("JSONの中身").setStyle(TextInputStyle.Paragraph).setRequired(true);
            const actionRow = new ActionRowBuilder().addComponents(cookieInput);
            modal.addComponents(actionRow);
            return interaction.showModal(modal);
        }

        if (commandName === 'join') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに参加してください！', ephemeral: true });
            joinVoiceChannel({ 
                channelId: voiceChannel.id, 
                guildId: guildId, 
                adapterCreator: guild.voiceAdapterCreator,
                selfDeaf: true // ★無音通信バグ対策
            });
            return interaction.reply('🔊 ボイスチャンネルに参加しました！');
        }

        if (commandName === 'leave') {
            const connection = getVoiceConnection(guildId);
            if (!connection) return interaction.reply('Botは参加していません。');
            if (serverQueue) { serverQueue.songs = []; serverQueue.player.stop(); queues.delete(guildId); }
            connection.destroy();
            return interaction.reply('👋 退出しました。');
        }

        if (commandName === 'play') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに入ってください！', ephemeral: true });
            await interaction.deferReply();

            const query = options.getString('query');
            const ytInfo = await play.search(query, { limit: 1 });
            if (!ytInfo.length) return interaction.editReply('動画が見つかりませんでした。');

            const song = { title: ytInfo[0].title, url: ytInfo[0].url, duration: ytInfo[0].durationRaw };

            if (!serverQueue) {
                const queueConstruct = {
                    textChannel: interaction.channel,
                    voiceChannel,
                    connection: joinVoiceChannel({ 
                        channelId: voiceChannel.id, 
                        guildId, 
                        adapterCreator: guild.voiceAdapterCreator,
                        selfDeaf: true // ★無音通信バグ対策
                    }),
                    songs: [song],
                    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
                };
                queues.set(guildId, queueConstruct);
                queueConstruct.connection.subscribe(queueConstruct.player);

                // ★万が一、裏でプレイヤーが落ちた場合にチャットに警告を出すよう修正
                queueConstruct.player.on('error', error => {
                    console.error('AudioPlayerError:', error);
                    queueConstruct.textChannel.send(`⚠️ 内部の音声プレイヤーでエラーが起きました: ${error.message}`);
                    queueConstruct.songs.shift();
                    playSong(guild, queueConstruct.songs[0]);
                });

                queueConstruct.player.on(AudioPlayerStatus.Idle, () => {
                    queueConstruct.songs.shift();
                    playSong(guild, queueConstruct.songs[0]);
                });

                playSong(guild, queueConstruct.songs[0]);
                return interaction.editReply(`▶️ **${song.title}** を再生します！`);
            } else {
                serverQueue.songs.push(song);
                return interaction.editReply(`📝 **${song.title}** をキューに追加しました。`);
            }
        }

        if (commandName === 'skip') {
            if (!serverQueue) return interaction.reply('スキップする曲がありません。');
            serverQueue.player.stop();
            return interaction.reply('⏭️ スキップしました。');
        }

        if (commandName === 'queue') {
            if (!serverQueue || serverQueue.songs.length === 0) return interaction.reply('キューは空です。');
            const list = serverQueue.songs.slice(0, 5).map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`).join('\n');
            return interaction.reply(`**現在のキュー:**\n${list}\n全${serverQueue.songs.length}曲`);
        }

        if (commandName === 'pause') {
            if (!serverQueue) return interaction.reply('再生中ではありません。');
            serverQueue.player.pause();
            return interaction.reply('⏸️ 一時停止しました。');
        }

        if (commandName === 'resume') {
            if (!serverQueue) return interaction.reply('曲がありません。');
            serverQueue.player.unpause();
            return interaction.reply('▶️ 再開します。');
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
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);
    } catch (error) {
        console.error(error);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ 読み込み失敗: サーバー通信エラー。次の曲へスキップします...`);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(process.env.DISCORD_TOKEN);
