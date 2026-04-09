const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

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

// コマンド定義
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
    // ★ ファイルアップロード方式のクッキー登録コマンド
    new SlashCommandBuilder()
        .setName('setcookie')
        .setDescription('YouTubeのクッキーJSONファイルを登録して403エラーを回避します')
        .addAttachmentOption(opt => 
            opt.setName('file')
               .setDescription('取得したクッキー情報を保存したJSONまたはテキストファイル')
               .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // 管理者限定
];

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // 環境変数に直接入力されている場合（文字数制限で切れていない場合に備えて）
    if (process.env.YOUTUBE_COOKIE) {
        try {
            await play.setToken({ youtube: { cookie: JSON.parse(process.env.YOUTUBE_COOKIE) } });
            console.log('環境変数から初期クッキーをロードしました');
        } catch (e) {
            console.log('環境変数のクッキーロードはスキップされました');
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

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, options, guild } = interaction;
    const voiceChannel = interaction.member.voice.channel;
    let serverQueue = queues.get(guildId);

    try {
        // --- ★ /setcookie コマンド (ファイル読み込み) ---
        if (commandName === 'setcookie') {
            await interaction.deferReply({ ephemeral: true }); // ファイルDLに時間がかかる可能性があるため待機状態にする

            const file = options.getAttachment('file');
            
            try {
                // Discordにアップロードされたファイルの中身をダウンロードして取得
                const response = await fetch(file.url);
                const fileText = await response.text();
                
                // 文字列をJSONとして解析
                const cookieObj = JSON.parse(fileText);
                
                // play-dlにクッキーを適用
                await play.setToken({
                    youtube: {
                        cookie: cookieObj
                    }
                });
                
                return interaction.editReply('✅ クッキーファイルを正常に読み込み、登録しました！これで再生制限が解除されます。');
            } catch (err) {
                console.error(err);
                return interaction.editReply('❌ ファイルの読み込みまたは解析に失敗しました。正常なJSON（テキスト）ファイルがアップロードされたか確認してください。');
            }
        }

        // --- 以下、既存の音楽コマンド機能 ---
        if (commandName === 'join') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに参加してください！', ephemeral: true });
            joinVoiceChannel({ channelId: voiceChannel.id, guildId: guildId, adapterCreator: guild.voiceAdapterCreator });
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
                    connection: joinVoiceChannel({ channelId: voiceChannel.id, guildId, adapterCreator: guild.voiceAdapterCreator }),
                    songs: [song],
                    player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
                };
                queues.set(guildId, queueConstruct);
                queueConstruct.connection.subscribe(queueConstruct.player);

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
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ 読み込み失敗。YouTube側で制限されている可能性があります。\`/setcookie\`コマンドで最新のクッキーファイルを登録してください。`);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(process.env.DISCORD_TOKEN);
