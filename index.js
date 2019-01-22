#!/usr/bin/env node

function requireEnv(key) {
    const value = process.env[key];
    if (!value) {
        print(`$${key} required but not set.`);
        process.exit(1);
    }
    return value;
}

const tele_token = requireEnv("TELEGRAM_TOKEN")
const nimiqx_token = requireEnv("NIMIQX_TOKEN");
const plotly_user = requireEnv("PLOTLY_USER");
const plotly_token = requireEnv("PLOTLY_TOKEN");

const TelegramBot = require('node-telegram-bot-api');
const request = require('request');
const Nimiq = require('@nimiq/core');
const plotly = require('plotly')(plotly_user, plotly_token);
const {Base64Decode} = require('base64-stream');
const svg2png = require("svg2png");

const bot = new TelegramBot(tele_token, {polling: true});

const nimiqx = url => new Promise((resolve, reject) => {
    request(url + '?api_key=' + nimiqx_token, { json: true }, (err, res, body) => {
        if (err)
            reject(err);
        else
            resolve(body);
    });
});

const nimiqWatch = url => new Promise((resolve, reject) => {
    request(url, { json: true }, (err, _res, body) => {
        if (err)
            reject(err);
        else
            resolve(body);
    });
});

function sendError(msg, err, customMsg) {
    bot.sendMessage(msg.chat.id, customMsg || "I can't reach the Nimiq network :( @terorie, do something!");
    console.log(err);
}

function humanHashes(bytes) {
    let thresh = 1000;
    if(Math.abs(bytes) < thresh) {
        return bytes + ' H/s';
    }
    let units = ['kH/s','MH/s','GH/s','TH/s','PH/s','EH/s','ZH/s','YH/s'];
    let u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while(Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1)+' '+units[u];
}

function humanNIM(nims) {
    if (nims < 1)
        return `${nims.toFixed(5)} NIM`;

    if (nims < 1e5)
        return `${nims.toFixed(3)} NIM`;

    nims /= 1e6;

    if (nims < 1e3)
        return `${nims.toFixed(2)}m NIM`;

    nims /= 1e3;

    return `${nims.toFixed(0)}b NIM`;
}

bot.onText(/\/start/, (msg, match) => {
    bot.sendMessage(msg.chat.id,
        "Hey, I'm HexaPoolBot 👋 I provide information about the Nimiq network. Add me to a group to start 😌. Type / for a list of commands.");
});

// /balance
// Get the balance of an account
bot.onText(/\/balance( (.+))?/, async (msg, match) => {
    if (!match[1]) {
        bot.sendMessage(msg.chat.id, "I need an address to check 🙉\nExample: /balance NQ11 P00L 2HYP TUK8 VY6L 2N22 MMBU MHHR BSAA");
        return;
    }

    let address;
    try {
        address = Nimiq.Address.fromUserFriendlyAddress(match[2]);
    } catch (e) {
        bot.sendMessage(msg.chat.id, "That's not a valid Nimiq address 🥺");
        return;
    }

    const body = await nimiqx('https://api.nimiqx.com/account/' + encodeURI(address.toUserFriendlyAddress()));
    if (!body.balance) {
        bot.sendMessage(msg.chat.id, "I can't find that address 🤔");
        return;
    }
    body.balance = Nimiq.Policy.satoshisToCoins(body.balance);
    bot.sendMessage(msg.chat.id, "Balance: " + body.balance + " NIM");
});

async function printGlobalHashrate(msg) {
    const hr = await nimiqx('https://api.nimiqx.com/network-stats/');
    const caption = "Global hashrate: " + humanHashes(hr.hashrate);

    const totalBlocks = (prev, e) => prev + e.blocks;

    let entries = await nimiqx('https://api.nimiqx.com/hashing-distribution/24h');

    const totalBlockCount = entries.reduce(totalBlocks);
    console.log(totalBlockCount);
    entries = entries.slice(0, 8);
    const truncBlockCount = entries.reduce(totalBlocks);
    const otherBlockCount = totalBlockCount - truncBlockCount;

    const values = entries.map(e => e.blocks);
    const labels = entries.map(e => e.label || e.address);
    if (otherBlockCount > 0) {
        values.push(otherBlockCount);
        values.push("Other");
    }

    const figure = { 'data': [{
        values: values,
        labels: labels,
        type: 'pie'
    }]};

    const opts = { width: 800, height: 500, format: 'png' };

    const stream = await new Promise((resolve, reject) => {
        plotly.getImage(figure, opts, (err, stream) => {
            if (err) reject(err);
            else resolve(stream);
        });
    });

    await bot.sendPhoto(
        msg.chat.id,
        (new Base64Decode).pipe(stream),
        { caption: caption },
        { contentType: 'image/png' }
    );
}

async function printHashrateOfAddress(msg, iban) {
    let address;
    try {
        address = Nimiq.Address.fromUserFriendlyAddress(iban);
    } catch (e) {
        bot.sendMessage(msg.chat.id, "That's not a valid Nimiq address 🥺");
        return;
    }

    try {
        const stats = await nimiqx('https://api.nimiqx.com/network-stats/');
        const hashrate = stats.hashrate;

        const addresses = await nimiqx('https://api.nimiqx.com/hashing-distribution/24h');

        let found;
        for (entry of addresses) {
            if (entry.address == address.toUserFriendlyAddress()) {
                found = entry;
                break;
            }
        }

        if (!found) {
            bot.sendMessage(msg.chat.id, "That address didn't mine any blocks this day 🤥. Note that pool hashrate is not yet displayed.");
            return;
        }

        const blockSplit = entry.blocks / (24 * 60);
        bot.sendMessage(msg.chat.id, "Hashrate: " + humanHashes(blockSplit * hashrate));
    } catch (e) {
        sendError(msg, e);
        return;
    }
}

// /hashrate
// Network hashrate (global or per address)
bot.onText(/\/hashrate( (.+))?/, async (msg, match) => {
    if (!match[1] || match[2] == "global") {
        await printGlobalHashrate(msg);
    } else {
        await printHashrateOfAddress(msg, match[2]);
    }
});

// /whales
// Biggest accounts $$$ 🤩
bot.onText(/\/whales/, async (msg, match) => {
    try {
        const balances = await nimiqx('https://api.nimiqx.com/top-account-balances/10');

        let text = "Biggest accounts 🤑\n\n";

        for (const account of balances) {
            const watchURL = `https://nimiq.watch/#${encodeURI(account.address)}`;
            const balance = humanNIM(account.balance);
            if (account.label) {
                text += `[${account.label}](${watchURL}): ${balance}\n`
            } else {
                text += `[${account.address.substr(0, 15)}...](${watchURL}): ${balance}\n`
            }
        }

        bot.sendMessage(msg.chat.id, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            disable_notification: true,
        });
    } catch (e) {
        sendError(msg, e);
        return;
    }
});

async function printGlobalProfit(msg) {
    try {
        const stats = await nimiqx('https://api.nimiqx.com/network-stats/');

        const nimPerKh = parseFloat(stats.nim_day_kh);

        let message = '';
        message += `NIM / kH / day: ${nimPerKh} NIM\n`
        message += `NIM / kH / week: ${humanNIM(nimPerKh * 7)}\n`
        message += `NIM / kH / month: ${humanNIM(nimPerKh * 30.4375)}\n`
        message += `Block reward: ${Nimiq.Policy.satoshisToCoins(stats.last_reward).toFixed(1)} NIM\n`
        message += `Difficulty: ${stats.difficulty.toFixed(0)}\n`
        message += `Global hashrate: ${humanHashes(stats.hashrate)}\n`

        bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            disable_notification: true,
        });
    } catch (e) {
        sendError(msg, e);
        return;
    }
}

async function printProfitOfHashrate(msg, hrStr) {
    try {
        hrStr = hrStr.toLowerCase();
        hrStr = hrStr.replace(/'`\/s h/g, '');
        hrStr = hrStr.replace(/,/g, '.');

        let mult;

        if (hrStr.indexOf("k") != -1) {
            mult = 1e3;
        } else if (hrStr.indexOf("m") != -1) {
            mult = 1e6;
        } else if (hrStr.indexOf("g") != -1) {
            mult = 1e9;
        } else {
            mult = 1;
        }

        hrStr = hrStr.replace(/kmg/g, '');

        let hashrate;
        try {
            hashrate = parseInt(hrStr);
            if (isNaN(hashrate))
                throw new Error("nan");
        } catch (e) {
            bot.sendMessage(msg.chat.id, "I can't decipher that 😗 Example: /profit 420 kH/s");
            return;
        }
        hashrate *= mult;

        const stats = await nimiqx('https://api.nimiqx.com/network-stats/');
        const price = await nimiqx('https://api.nimiqx.com/price/usd');

        let message = '';
        if (hashrate > stats.hashrate) {
            message += 'Is that a 101 % attack?\n';
        }

        const nimPerKh = parseFloat(stats.nim_day_kh) * hashrate / 1000;

        const nimDay = nimPerKh;
        const nimWeek = nimPerKh * 7;
        const nimMonth = nimPerKh * 30.4375;

        price.usd = parseFloat(price.usd);
        const format = nim => `${humanNIM(nim)} / $${(nim * price.usd).toFixed(2)}`;

        message += `Day: ${format(nimDay)}\n`
        message += `Week: ${format(nimWeek)}\n`
        message += `Month: ${format(nimMonth)}\n`
        message += `Blocks / day: ${((hashrate / stats.hashrate) * (60 * 24)).toFixed(4)}\n`
        message += `Block reward: ${Nimiq.Policy.satoshisToCoins(stats.last_reward).toFixed(1)} NIM\n`
        message += `Difficulty: ${stats.difficulty.toFixed(0)}\n`
        message += `Global hashrate: ${humanHashes(stats.hashrate)}\n`

        bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            disable_notification: true,
        });
    } catch (e) {
        sendError(msg, e);
        return;
    }
}

// /profit
// Check how much you earn by mining
bot.onText(/\/profit( (.+))?/, async (msg, match) => {
    if (!match[1]) {
        await printGlobalProfit(msg);
    } else {
        await printProfitOfHashrate(msg, match[2]);
    }
});

function formatTable(rows, cols) {
    const widths = {};
    for (col of cols) {
        let maxW = 0;
        for (row of rows) {
            if (row[col] > maxW)
                maxW = row[col];
        }
        widths[col] = maxW;
    }

    let out;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (let j = 0; j < cols.length; j++) {
            const col = cols[j];
            let entry = row[col];
            for (let w = widths[col] - entry.length; w >= 0; w--)
                entry += ' ';
            out += entry;
            if (j != cols.length - 1)
                out += ' ';
        }
        if (i != rows.length - 1)
            out += '\n';
    }

    return out;
}

// /supply
// Supply info
bot.onText(/\/supply/, async (msg, match) => {
    try {
        // Get current height from Nimiq Watch
        const stats = await nimiqWatch("https://api.nimiq.watch/latest/1");
        const height = stats[0].height;

        const knownCoins = Nimiq.Policy.satoshisToCoins(Nimiq.Policy.supplyAfter(height));
        const totalCoins = 21e9;
        const percentage = 100 * (knownCoins / totalCoins);
        const reward = Nimiq.Policy.satoshisToCoins(Nimiq.Policy.blockRewardAt(height));

        let message = '';
        message += `Known coins: ${humanNIM(knownCoins)} (${percentage.toFixed(1)} %)\n`
        message += `Total supply: ${humanNIM(totalCoins)}\n`
        message += `Left to mine: ${humanNIM(totalCoins - knownCoins)}\n`
        message += `Last block reward: ${reward.toFixed(1)} NIM\n`

        bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            disable_notification: true,
        });
    } catch (e) {
        sendError(msg, e);
        return;
    }
});

// /price
// Check the current NIM price
bot.onText(/\/price/, async (msg, match) => {
    try {
        const stats = await nimiqx('https://api.nimiqx.com/price/btc,usd,eur');

        const lines = [
            { "code": "usd", "sym": "US$" },
            { "code": "eur", "sym": "€  " }
        ];

        let message = '';
        message += "```"

        const btcPrice = parseFloat(stats["btc"])
        message += '\n' + `1 NIM = ${(1000 * btcPrice).toFixed(5)} mBTC`;
        message += '\n' + `1 BTC = ${humanNIM(1 / btcPrice)}`;

        for (line of lines) {
            line.value = parseFloat(stats[line.code]);
            line.valueStr = `1 NIM = ${line.value.toFixed(5)} ${line.sym}`;

            message += '\n' + line.valueStr;

            line.price = 1 / line.value;
            line.priceStr = `1 ${line.sym} = ${humanNIM(line.price)}`;

            message += '\n' + line.priceStr;
        }

        //message += formatTable(lines, ["priceStr", "valueStr"])
        message += "```"

        bot.sendMessage(msg.chat.id, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            disable_notification: true,
        });
    } catch (e) {
        sendError(msg, e);
        return;
    }
});

// /iqon
// Generate your Nimiq iqon
bot.onText(/\/iqon( (.+))?/, async (msg, match) => {
    if (!match[1]) {
        bot.sendMessage(msg.chat.id, "You need to give me an address! Example: /iqon NQ11 P00L 2HYP TUK8 VY6L 2N22 MMBU MHHR BSAA");
        return;
    }

    try {
        const iban = match[2];
        let addr;
        try {
            addr = Nimiq.Address.fromUserFriendlyAddress(iban);
        } catch (e) {
            bot.sendMessage(msg.chat.id, "That's not a valid Nimiq address 🥺");
            return;
        }

        const iqonResp = await nimiqx(`https://api.nimiqx.com/iqon/${encodeURI(addr.toUserFriendlyAddress())}`);
        const svgB64 = iqonResp.img_src.substr(26);
        const svgBuf = Buffer.from(svgB64, 'base64');

        const png = await svg2png(svgBuf, { width: 400, height: 400 });

        await bot.sendSticker(
            msg.chat.id,
            png,
            { caption: addr.toUserFriendlyAddress() },
            { contentType: 'image/png' }
        );
    } catch (e) {
        sendError(msg, e, "Encoder failed 🤦🏻‍ @terorie pls fix.");
    }
});
