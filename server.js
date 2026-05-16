require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const http = require('http');
const { Address, beginCell, internal, toNano } = require('@ton/core');
const { TonClient, WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const JETTON_TRANSFER_OP = 0x0f8a7ea5;
const DEFAULT_JETTON_MASTER = 'EQCtJiXSoQPBRMh2yijkSyTZ1iqkj-uQRKvvaAUlkFLUwsS6';
const DEFAULT_TOKEN_SYMBOL = 'T0H';
const JETTON_TRANSFER_TON = '0.08';
const FORWARD_TON_AMOUNT = '0.000000001';

let claimQueue = Promise.resolve();

function getConfig() {
    const network = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet';

    return {
        network,
        endpoint: process.env.TONCENTER_ENDPOINT || (
            network === 'testnet'
                ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
                : 'https://toncenter.com/api/v2/jsonRPC'
        ),
        apiKey: process.env.TONCENTER_API_KEY || undefined,
        jettonMaster: process.env.JETTON_MASTER || DEFAULT_JETTON_MASTER,
        claimAmount: BigInt(process.env.CLAIM_AMOUNT || '1000000'),
        tokenDecimals: Number(process.env.TOKEN_DECIMALS || '6'),
        tokenSymbol: process.env.TOKEN_SYMBOL || DEFAULT_TOKEN_SYMBOL,
        transferTonAmount: JETTON_TRANSFER_TON,
        forwardTonAmount: FORWARD_TON_AMOUNT,
        seqnoWaitAttempts: Number(process.env.SEQNO_WAIT_ATTEMPTS || '20'),
    };
}

function getMnemonicWords() {
    const mnemonic = (process.env.MNEMONIC || '').trim();

    if (!mnemonic) {
        throw new Error('MNEMONIC is not configured');
    }

    const words = mnemonic.split(/\s+/);

    if (words.length < 12) {
        throw new Error('MNEMONIC must contain 12 or 24 words');
    }

    return words;
}

function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';

        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 4096) {
                req.destroy();
                reject(new Error('Request body too large'));
            }
        });

        req.on('end', () => {
            if (!body) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(payload));
}

function formatAddress(address, config = getConfig()) {
    return address.toString({
        bounceable: false,
        urlSafe: true,
        testOnly: config.network === 'testnet',
    });
}

function normalizeAddress(address, config = getConfig()) {
    return Address.parse(address).toString({
        bounceable: false,
        urlSafe: true,
        testOnly: config.network === 'testnet',
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSeqno(walletContract, seqno, attempts) {
    for (let i = 0; i < attempts; i += 1) {
        await sleep(1500);
        const nextSeqno = await walletContract.getSeqno();

        if (nextSeqno > seqno) {
            return nextSeqno;
        }
    }

    return null;
}

async function getJettonWalletAddress(client, jettonMaster, ownerAddress) {
    const result = await client.runMethod(jettonMaster, 'get_wallet_address', [
        {
            type: 'slice',
            cell: beginCell().storeAddress(ownerAddress).endCell(),
        },
    ]);

    return result.stack.readAddress();
}

function buildJettonTransferBody({ queryId, amount, recipient, responseAddress, forwardTonAmount }) {
    return beginCell()
        .storeUint(JETTON_TRANSFER_OP, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(recipient)
        .storeAddress(responseAddress)
        .storeMaybeRef(null)
        .storeCoins(forwardTonAmount)
        .storeBit(0)
        .storeUint(0, 32)
        .storeStringTail('Jetton airdrop')
        .endCell();
}

async function sendJettonAirdrop(recipientAddress) {
    const config = getConfig();
    const client = new TonClient({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
    });

    const keyPair = await mnemonicToPrivateKey(getMnemonicWords());
    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
    });
    const walletContract = client.open(wallet);
    const senderAddress = wallet.address;
    const jettonMaster = Address.parse(config.jettonMaster);
    const recipient = Address.parse(recipientAddress);
    const senderJettonWallet = await getJettonWalletAddress(client, jettonMaster, senderAddress);
    const seqno = await walletContract.getSeqno();
    const queryId = BigInt(Date.now());

    const body = buildJettonTransferBody({
        queryId,
        amount: config.claimAmount,
        recipient,
        responseAddress: senderAddress,
        forwardTonAmount: toNano(config.forwardTonAmount),
    });

    await walletContract.sendTransfer({
        secretKey: keyPair.secretKey,
        seqno,
        messages: [
            internal({
                to: senderJettonWallet,
                value: toNano(config.transferTonAmount),
                bounce: true,
                body,
            }),
        ],
    });

    const nextSeqno = await waitForSeqno(walletContract, seqno, config.seqnoWaitAttempts);

    return {
        accepted: nextSeqno !== null,
        recipient: normalizeAddress(recipientAddress, config),
        jettonMaster: formatAddress(jettonMaster, config),
        senderWallet: formatAddress(senderAddress, config),
        senderJettonWallet: formatAddress(senderJettonWallet, config),
        amount: config.claimAmount.toString(),
        tokenDecimals: config.tokenDecimals,
        tokenSymbol: config.tokenSymbol,
        seqno,
        nextSeqno,
        queryId: queryId.toString(),
    };
}

function enqueueClaim(task) {
    const run = claimQueue.then(task, task);
    claimQueue = run.catch(() => {});
    return run;
}

async function handleClaim(req, res) {
    const body = await parseJsonBody(req);
    const config = getConfig();
    let recipient;

    try {
        recipient = normalizeAddress(body.address || '', config);
    } catch (e) {
        sendJson(res, 400, {
            ok: false,
            error: 'Invalid TON address',
        });
        return;
    }

    const result = await enqueueClaim(async () => {
        return sendJettonAirdrop(recipient);
    });

    sendJson(res, 200, {
        ok: true,
        message: 'Airdrop transaction submitted',
        claim: result,
    });
}

async function handleRequest(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    try {
        if (req.method === 'GET' && requestUrl.pathname === '/health') {
            const config = getConfig();
            sendJson(res, 200, {
                ok: true,
                network: config.network,
                jettonMaster: config.jettonMaster,
            });
            return;
        }

        if (req.method === 'GET' && requestUrl.pathname === '/config') {
            const config = getConfig();
            sendJson(res, 200, {
                ok: true,
                network: config.network,
                jettonMaster: config.jettonMaster,
                claimAmount: config.claimAmount.toString(),
                tokenDecimals: config.tokenDecimals,
                tokenSymbol: config.tokenSymbol,
                claimOnce: false,
            });
            return;
        }

        if (req.method === 'POST' && requestUrl.pathname === '/api/claim') {
            await handleClaim(req, res);
            return;
        }

        sendJson(res, 404, {
            ok: false,
            error: 'Not found',
        });
    } catch (e) {
        console.error('[airdrop:error]', e.message);
        sendJson(res, 500, {
            ok: false,
            error: e.message,
        });
    }
}

const port = Number(process.env.PORT || 3000);

http.createServer(handleRequest).listen(port, () => {
    const config = getConfig();
    console.log(`TON Jetton airdrop backend listening on port ${port}`);
    console.log(`Network: ${config.network}`);
    console.log(`Jetton master: ${config.jettonMaster}`);
});
