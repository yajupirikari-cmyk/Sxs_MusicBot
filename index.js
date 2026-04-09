const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');
const express = require('express');

// ==========================================
// 1. ダミーWebサーバー (Render運用 & UptimeRobotスリープ防止用)
// ==========================================
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.status(200).send('Discord Slash Commands Music Bot Running!');
});

app.listen(port, () => {
    console.log(`Web server is listening on port ${port}`);
});

// ==========================================
// 2. Discord 音楽Bot ロジック (スラッシュコマンド対応)
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates, // ボイス接続に必要
        // (スラッシュコマンドを使用するため MessageContent のインテントは不要になりました)
    ]
});

const queues = new Map();

// ----------------------------------------
// スラッシュコマンドの定義
// ----------------------------------------
const commands = [
    new SlashCommandBuilder().setName('join').setDescription('ボイスチャンネルにBotを参加させます'),
    new SlashCommandBuilder().setName('leave').setDescription('再生を停止し、ボイスチャンネルから退出させます'),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('指定した音楽を再生、または再生順（キュー）に追加します')
        .addStringOption(option => 
            option.setName('query')
                .setDescription('検索したい曲名、またはYouTubeのURL')
                .setRequired(true)
        ),
    new SlashCommandBuilder().setName('skip').setDescription('現在流れている曲をスキップします'),
    new SlashCommandBuilder().setName('queue').setDescription('現在の再生予定リスト（キュー）を確認します'),
    new SlashCommandBuilder().setName('pause').setDescription('流れている音楽を一時停止します'),
    new SlashCommandBuilder().setName('resume').setDescription('一時停止した音楽の再生を再開します'),
];

// Botの起動時にスラッシュコマンドをDiscordシステムに登録する
client.on('ready', async () => {
    console.log(`Bot logged in successfully as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        console.log('スラッシュコマンドの登録を開始します...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('スラッシュコマンドの登録が完了しました！Discord内で使用可能です。');
    } catch (error) {
        console.error('スラッシュコマンドの登録中にエラーが発生しました:', error);
    }
});

// ----------------------------------------
// コマンドが実行された時の処理
// ----------------------------------------
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return; // スラッシュコマンド以外は無視

    const { commandName } = interaction;
    const voiceChannel = interaction.member.voice.channel;

    try {
        // ===== /join (ジョイン) =====
        if (commandName === 'join') {
            if (!voiceChannel) {
                return interaction.reply({ content: '先にいずれかのボイスチャンネルに参加してください！', ephemeral: true });
            }
            
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: interaction.guild.id,
                adapterCreator: interaction.guild.voiceAdapterCreator,
            });
            await interaction.reply('🔊 ボイスチャンネルに参加しました！');
        }

        // ===== /leave (退出) =====
        if (commandName === 'leave') {
            const connection = getVoiceConnection(interaction.guild.id);
            if (!connection) {
                return interaction.reply({ content: 'Botはどのボイスチャンネルにも参加していません。', ephemeral: true });
            }

            const serverQueue = queues.get(interaction.guild.id);
            if (serverQueue) {
                serverQueue.songs = []; // キューをリセット
                serverQueue.player.stop();
                queues.delete(interaction.guild.id);
            }

            connection.destroy(); // 切断
            await interaction.reply('👋 再生を終了し、ボイスチャンネルから退出しました！');
        }

        // ===== /play (再生) =====
        if (commandName === 'play') {
            if (!voiceChannel) return interaction.reply({ content: '先にボイスチャンネルに参加してください！', ephemeral: true });

            // 検索に数秒かかる場合があるため、Discordからタイムアウトされないよう「考え中...」の待機状態にする
            await interaction.deferReply(); 

            const query = interaction.options.getString('query');
            let serverQueue = queues.get(interaction.guild.id);

            const ytInfo = await play.search(query, { limit: 1 });
            if (!ytInfo || ytInfo.length === 0) {
                return interaction.editReply('指定された検索条件で動画が見つかりませんでした。');
            }

            const songData = ytInfo[0];
            const song = {
                title: songData.title,
                url: songData.url,
                duration: songData.durationRaw // 例: "4:30"
            };

            // はじめて再生する場合
            if (!serverQueue) {
                const queueConstruct = {
                    textChannel: interaction.channel,
                    voiceChannel: voiceChannel,
                    connection: null,
                    songs: [],
                    player: createAudioPlayer({
                        behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
                    }),
                    playing: true
                };

                queues.set(interaction.guild.id, queueConstruct);
                queueConstruct.songs.push(song);

                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                });
                
                queueConstruct.connection = connection;
                connection.subscribe(queueConstruct.player);

                // 曲が終わったら次へ移行
                queueConstruct.player.on(AudioPlayerStatus.Idle, () => {
                    queueConstruct.songs.shift(); // 終わった曲を配列から削除
                    playSong(interaction.guild, queueConstruct.songs[0]); // 次の曲
                });

                queueConstruct.player.on('error', error => {
                    console.error('AudioPlayerError:', error);
                    queueConstruct.songs.shift();
                    playSong(interaction.guild, queueConstruct.songs[0]);
                });

                playSong(interaction.guild, queueConstruct.songs[0]);
                await interaction.editReply(`▶️ **${song.title}** の再生を開始します！`);
            } else {
                // 既に再生中の場合はキューの後ろに追加
                serverQueue.songs.push(song);
                await interaction.editReply(`📝 **${song.title}** を再生リストに追加しました！`);
            }
        }

        // ===== /skip (スキップ) =====
        if (commandName === 'skip') {
            const serverQueue = queues.get(interaction.guild.id);
            if (!voiceChannel) return interaction.reply({ content: 'ボイスチャンネルに参加してください！', ephemeral: true });
            if (!serverQueue || serverQueue.songs.length === 0) {
                return interaction.reply({ content: '現在スキップする曲が存在しません。', ephemeral: true });
            }

            serverQueue.player.stop(); // 停止すると自動でIdleイベントが呼ばれ、次の曲へ飛ぶ
            await interaction.reply('⏭️ 現在の曲をスキップしました！');
        }

        // ===== /queue (キュー一覧) =====
        if (commandName === 'queue') {
            const serverQueue = queues.get(interaction.guild.id);
            if (!serverQueue || serverQueue.songs.length === 0) {
                return interaction.reply({ content: '現在再生リストには何もありません。', ephemeral: true });
            }

            // キュー内の最大10曲だけを表示する（文字数制限対策）
            let queueString = serverQueue.songs.slice(0, 10).map((song, index) => {
                return `${index === 0 ? '**[再生中]**' : `**${index}.**`} ${song.title} (${song.duration})`;
            }).join('\n');

            if (serverQueue.songs.length > 10) {
                queueString += `\n\n...他 ${serverQueue.songs.length - 10} 曲`;
            }

            await interaction.reply(`**🎵 現在の再生リスト:**\n${queueString}`);
        }

        // ===== /pause (一時停止) =====
        if (commandName === 'pause') {
            const serverQueue = queues.get(interaction.guild.id);
            if (!serverQueue) return interaction.reply({ content: '再生中の曲がありません。', ephemeral: true });

            serverQueue.player.pause();
            await interaction.reply('⏸️ 再生を一時停止しました。');
        }

        // ===== /resume (再開) =====
        if (commandName === 'resume') {
            const serverQueue = queues.get(interaction.guild.id);
            if (!serverQueue) return interaction.reply({ content: '再生中の曲がありません。', ephemeral: true });

            serverQueue.player.unpause();
            await interaction.reply('▶️ 再生を再開しました。');
        }

    } catch (cmdError) {
        console.error('Command Execution Error:', cmdError);
        // 万が一エラーが起きてもBotが落ちないようにする
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ コマンドの実行中に内部エラーが発生しました。').catch(console.error);
        } else {
            await interaction.reply({ content: '❌ コマンドの実行中に内部エラーが発生しました。', ephemeral: true }).catch(console.error);
        }
    }
});

/**
 * 実際に音楽ストリームを取得し、Discord内で再生する関数
 */
async function playSong(guild, song) {
    const serverQueue = queues.get(guild.id);
    if (!serverQueue) return;

    // キューが空になった場合（退出させずに無音で待機させます）
    if (!song) return; 

    try {
        const stream = await play.stream(song.url);
        const resource = createAudioResource(stream.stream, { inputType: stream.type });
        serverQueue.player.play(resource);
    } catch (error) {
        console.error('Failed to play the song:', error);
        if (serverQueue.textChannel) {
            serverQueue.textChannel.send(`⚠️ 曲のストリーム読み込みに失敗しました。次の曲へスキップします: **${song.title}**`);
        }
        serverQueue.songs.shift(); // 失敗した曲を消して次を再生
        playSong(guild, serverQueue.songs[0]);
    }
}

// Botログイン
client.login(process.env.DISCORD_TOKEN);
