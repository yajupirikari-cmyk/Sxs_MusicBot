const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// 1. ダミーWebサーバー (Render & UptimeRobot スリープ防止)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('Discord Music Bot 24/7 with Cookie Manager is Online!'));
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
    // クッキー登録用コマンド (セキュリティのため管理者権限のみ許可することも可能)
    new SlashCommandBuilder()
        .setName('setcookie')
        .setDescription('YouTubeのクッキーJSONを登録して403エラーを回避します')
        .addStringOption(opt => opt.setName('json').setDescription('取得したJSON文字列をここに貼り付けてください').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // 管理者のみ実行可能
];

// 起動時の処理
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // 環境変数にクッキーがあれば初期セット
    if (process.env.YOUTUBE_COOKIE) {
        try {
            await play.setToken({ youtube: { cookie: JSON.parse(process.env.YOUTUBE_COOKIE) } });
            console.log('環境変数から初期クッキーをロードしました');
        } catch (e) {
            console.error('環境変数のクッキーロードに失敗しました');
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

// インタラクション処理
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId, options, guild } = interaction;
    const voiceChannel = interaction.member.voice.channel;
    let serverQueue = queues.get(guildId);

    try {
        // --- /setcookie コマンド ---
        if (commandName === 'setcookie') {
            const jsonStr = options.getString('json');
            try {
                const cookieObj = JSON.parse(jsonStr);
                await play.setToken({
                    youtube: {
                        cookie: cookieObj
                    }
                });
                return interaction.reply({ content: '✅ YouTubeクッキーを正常に登録しました！これで再生制限が解除されます。', ephemeral: true });
            } catch (err) {
                console.error(err);
                return interaction.reply({ content: '❌ JSONの形式が正しくありません。取得した中身をそのまま貼り付けてください。', ephemeral: true });
            }
        }

        // --- /join ---
        if (commandName === 'join') {
            if (!voiceChannel) return interaction.reply({ content: '先にVCに参加してください！', ephemeral: true });
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: guildId,
                adapterCreator: guild.voiceAdapterCreator,
            });
            return interaction.reply('🔊 ボイスチャンネルに参加しました！');
        }

        // --- /leave ---
        if (commandName === 'leave') {
            const connection = getVoiceConnection(guildId);
            if (!connection) return interaction.reply('Botは参加していません。');
            if (serverQueue) { serverQueue.songs = []; serverQueue.player.stop(); queues.delete(guildId); }
            connection.destroy();
            return interaction.reply('👋 退出しました。');
        }

        // --- /play ---
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

        // --- /skip ---
        if (commandName === 'skip') {
            if (!serverQueue) return interaction.reply('スキップする曲がありません。');
            serverQueue.player.stop();
            return interaction.reply('⏭️ スキップしました。');
        }

        // --- /queue ---
        if (commandName === 'queue') {
            if (!serverQueue) return interaction.reply('キューは空です。');
            const list = serverQueue.songs.slice(0, 5).map((s, i) => `${i === 0 ? '▶️' : `${i}.`} ${s.title}`).join('\n');
            return interaction.reply(`**現在のキュー:**\n${list}\n全${serverQueue.songs.length}曲`);
        }

        // --- /pause ---
        if (commandName === 'pause') {
            if (!serverQueue) return interaction.reply('再生中ではありません。');
            serverQueue.player.pause();
            return interaction.reply('⏸️ 一時停止しました。');
        }

        // --- /resume ---
        if (commandName === 'resume') {
            if (!serverQueue) return interaction.reply('曲がありません。');
            serverQueue.player.unpause();
            return interaction.reply('▶️ 再開します。');
        }

    } catch (e) {
        console.error(e);
        if (interaction.deferred) interaction.editReply('❌ エラーが発生しました。クッキーを再設定してみてください。');
    }
});

async function playSong(guild, song) {
    const serverQueue = queues.get(guild.id);
    if (!song) return; // 終わっても勝手に退出はさせない（/leaveで退出）

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);
    } catch (error) {
        console.error(error);
        if (serverQueue.textChannel) serverQueue.textChannel.send(`⚠️ 読み込み失敗。クッキーが無効な可能性があります。/setcookie を試してください。`);
        serverQueue.songs.shift();
        playSong(guild, serverQueue.songs[0]);
    }
}

client.login(process.env.DISCORD_TOKEN);
