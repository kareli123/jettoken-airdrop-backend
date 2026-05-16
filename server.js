require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const http = require('http');
const { Address, beginCell, internal, toNano } = require('@ton/core');
const ton = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const BUILD_TAG = 'v3-debug';

const TonClient = ton.TonClient;
const WalletContractV4 = ton.WalletContractV4;
const WalletContractV5R1 = ton.WalletContractV5R1 || null;

console.log('[boot] Build:', BUILD_TAG);
console.log('[boot] WalletContractV4 available:', !!WalletContractV4);
console.log('[boot] WalletContractV5R1 available:', !!WalletContractV5R1);
console.log('[boot] MNEMONIC set:', !!(process.env.MNEMONIC || '').trim());
console.log('[boot] MNEMONIC words:', (process.env.MNEMONIC || '').trim().split(/\s+/).length);
console.log('[boot] TONCENTER_API_KEY set:', !!process.env.TONCENTER_API_KEY);
console.log('[boot] JETTON_MASTER:', process.env.JETTON_MASTER || '(default)');
console.log('[boot] NETWORK:', process.env.NETWORK || '(default mainnet)');
console.log('[boot] CLAIM_AMOUNT:', process.env.CLAIM_AMOUNT || '(default 1000000)');
console.log('[boot] WALLET_VERSION:', process.env.WALLET_VERSION || '(default v5r1)');

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
        throw new Error('MNEMONIC must contain 12 or 24 words (got ' + words.length + ')');
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
        try {
            const nextSeqno = await walletContract.getSeqno();
            if (nextSeqno > seqno) {
                return nextSeqno;
            }
        } catch (e) {
            console.log('[airdrop] waitForSeqno attempt', i, 'error:', e.message);
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
    const walletVersion = process.env.WALLET_VERSION || 'v5r1';

    console.log('=== CLAIM START ===');
    console.log('[step 0] recipient:', recipientAddress);
    console.log('[step 0] walletVersion:', walletVersion);
    console.log('[step 0] endpoint:', config.endpoint);
    console.log('[step 0] apiKey set:', !!config.apiKey);
    console.log('[step 0] jettonMaster:', config.jettonMaster);
    console.log('[step 0] claimAmount:', config.claimAmount.toString());

    // Step 1: Create TonClient
    console.log('[step 1] Creating TonClient...');
    const client = new TonClient({
        endpoint: config.endpoint,
        apiKey: config.apiKey,
    });
    console.log('[step 1] TonClient created OK');

    // Step 2: Derive keys from mnemonic
    console.log('[step 2] Deriving keys from mnemonic...');
    let keyPair;
    try {
        keyPair = await mnemonicToPrivateKey(getMnemonicWords());
        console.log('[step 2] Keys derived OK, pubkey:', keyPair.publicKey.toString('hex').slice(0, 16) + '...');
    } catch (e) {
        console.error('[step 2] FAILED:', e.message);
        throw e;
    }

    // Step 3: Create wallet
    console.log('[step 3] Creating wallet contract (' + walletVersion + ')...');
    let wallet;
    try {
        if (walletVersion === 'v5r1' && WalletContractV5R1) {
            wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
        } else {
            console.log('[step 3] Falling back to WalletContractV4');
            wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
        }
        console.log('[step 3] Wallet address:', wallet.address.toString());
    } catch (e) {
        console.error('[step 3] FAILED:', e.message);
        throw e;
    }

    const walletContract = client.open(wallet);
    const senderAddress = wallet.address;
    const jettonMaster = Address.parse(config.jettonMaster);
    const recipient = Address.parse(recipientAddress);

    // Step 4: Get sender's jetton wallet address
    console.log('[step 4] Getting sender jetton wallet address...');
    let senderJettonWallet;
    try {
        senderJettonWallet = await getJettonWalletAddress(client, jettonMaster, senderAddress);
        console.log('[step 4] Sender jetton wallet:', senderJettonWallet.toString());
    } catch (e) {
        console.error('[step 4] FAILED:', e.message);
        console.error('[step 4] Stack:', e.stack);
        throw new Error('Failed to get jetton wallet address: ' + e.message);
    }

    // Step 5: Get seqno
    console.log('[step 5] Getting wallet seqno...');
    let seqno;
    try {
        seqno = await walletContract.getSeqno();
        console.log('[step 5] Seqno:', seqno);
    } catch (e) {
        console.error('[step 5] FAILED:', e.message);
        console.error('[step 5] This usually means the wallet is not deployed or has no TON balance');
        throw new Error('Failed to get seqno (wallet may not be deployed): ' + e.message);
    }

    // Step 6: Build transfer body
    console.log('[step 6] Building transfer body...');
    const queryId = BigInt(Date.now());
    let body;
    try {
        body = buildJettonTransferBody({
            queryId,
            amount: config.claimAmount,
            recipient,
            responseAddress: senderAddress,
            forwardTonAmount: toNano(config.forwardTonAmount),
        });
        console.log('[step 6] Body built OK');
    } catch (e) {
        console.error('[step 6] FAILED:', e.message);
        throw e;
    }

    // Step 7: Send transfer
    console.log('[step 7] Sending transfer...');
    try {
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
        console.log('[step 7] Transfer sent OK');
    } catch (e) {
        console.error('[step 7] FAILED:', e.message);
        console.error('[step 7] Stack:', e.stack);
        throw new Error('Failed to send transfer: ' + e.message);
    }

    // Step 8: Wait for confirmation
    console.log('[step 8] Waiting for seqno confirmation...');
    const nextSeqno = await waitForSeqno(walletContract, seqno, config.seqnoWaitAttempts);
    console.log('[step 8] nextSeqno:', nextSeqno);
    console.log('=== CLAIM END ===');

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
    console.log('[claim] POST /api/claim received');
    const body = await parseJsonBody(req);
    console.log('[claim] body.address:', body.address);
    const config = getConfig();
    let recipient;

    try {
        recipient = normalizeAddress(body.address || '', config);
        console.log('[claim] normalized recipient:', recipient);
    } catch (e) {
        console.log('[claim] Invalid address:', body.address);
        sendJson(res, 400, {
            ok: false,
            error: 'Invalid TON address',
        });
        return;
    }

    try {
        const result = await enqueueClaim(async () => {
            return sendJettonAirdrop(recipient);
        });

        sendJson(res, 200, {
            ok: true,
            message: 'Airdrop transaction submitted',
            claim: result,
        });
    } catch (e) {
        console.error('[claim] AIRDROP ERROR:', e.message);
        sendJson(res, 500, {
            ok: false,
            error: e.message,
        });
    }
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
                build: BUILD_TAG,
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
        console.error('[airdrop:stack]', e.stack);
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
