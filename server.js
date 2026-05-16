// Jettoken Airdrop Backend
// Mints your jettoken to users who claim via the frontend
// Uses direct TonCenter HTTP API with API key

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Address, beginCell, toNano, WalletContractV4, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();

// CORS - allow all origins
app.use(cors());
app.options('*', cors());

app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
    next();
});

// --- Config ---
const JETTON_MASTER = process.env.JETTON_MASTER || 'EQB0qpljZl3xD0pbWPM3PCEn6bQfDe6Xx7a7W4qtBs45axmj';
const CLAIM_AMOUNT = parseFloat(process.env.CLAIM_AMOUNT || '100');
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '9');
const NETWORK = process.env.NETWORK || 'mainnet';
const PORT = parseInt(process.env.PORT || '3001');
const MNEMONIC = process.env.MNEMONIC;
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const API_ENDPOINT = NETWORK === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
    : 'https://toncenter.com/api/v2/jsonRPC';

// Token amount in smallest units (nano-jettons)
const CLAIM_AMOUNT_NANO = BigInt(Math.floor(CLAIM_AMOUNT * Math.pow(10, TOKEN_DECIMALS)));

// --- Claims database (simple JSON file) ---
const CLAIMS_FILE = path.join(__dirname, 'claims.json');

function loadClaims() {
    try {
        if (fs.existsSync(CLAIMS_FILE)) {
            return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading claims:', e);
    }
    return { claims: [] };
}

function saveClaims(data) {
    fs.writeFileSync(CLAIMS_FILE, JSON.stringify(data, null, 2));
}

function hasClaimed(address) {
    const data = loadClaims();
    return data.claims.some(c => c.address === address);
}

function recordClaim(address, txHash) {
    const data = loadClaims();
    data.claims.push({
        address: address,
        amount: CLAIM_AMOUNT,
        txHash: txHash || null,
        timestamp: new Date().toISOString()
    });
    saveClaims(data);
}

// --- TonCenter API helper ---
const apiHeaders = {};
if (TONCENTER_API_KEY) {
    apiHeaders['X-API-Key'] = TONCENTER_API_KEY;
}

async function apiCall(method, params) {
    const res = await axios.post(API_ENDPOINT, {
        id: '1',
        jsonrpc: '2.0',
        method: method,
        params: params
    }, {
        headers: apiHeaders,
        timeout: 30000
    });

    if (res.data.error) {
        throw new Error(`TonCenter API error: ${res.data.error.message}`);
    }

    return res.data.result;
}

// --- TON Client ---
let keyPair = null;
let wallet = null;

async function initTonClient() {
    if (!MNEMONIC) {
        console.error('ERROR: MNEMONIC not set in .env file!');
        process.exit(1);
    }

    keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));

    wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
    });

    console.log('Admin wallet address:', wallet.address.toString());
    console.log('Jetton Master:', JETTON_MASTER);
    console.log('Claim amount:', CLAIM_AMOUNT, 'tokens');
    console.log('Network:', NETWORK);
    console.log('API key set:', TONCENTER_API_KEY ? 'YES' : 'NO (free tier)');
    console.log('Endpoint:', API_ENDPOINT);

    // Test API connection
    try {
        const state = await apiCall('getAddressInformation', { address: wallet.address.toString() });
        console.log('Wallet state:', state);
    } catch (e) {
        console.error('API test failed:', e.message);
        if (e.message.includes('429') || e.message.includes('rate')) {
            console.error('ERROR: Rate limited by TonCenter. Add TONCENTER_API_KEY!');
            process.exit(1);
        }
    }
}

// --- Build Mint Message ---
function buildMintBody(receiverAddress) {
    const jettonMasterAddr = Address.parse(JETTON_MASTER);
    const receiverAddr = Address.parse(receiverAddress);

    const internalTransfer = beginCell()
        .storeUint(0x178d4519, 32)
        .storeUint(0, 64)
        .storeCoins(CLAIM_AMOUNT_NANO)
        .storeAddress(jettonMasterAddr)
        .storeAddress(receiverAddr)
        .storeCoins(toNano('0.01'))
        .storeBit(0)
        .endCell();

    const mintBody = beginCell()
        .storeUint(0x642b7d07, 32)
        .storeUint(0, 64)
        .storeAddress(receiverAddr)
        .storeCoins(toNano('0.05'))
        .storeRef(internalTransfer)
        .endCell();

    return mintBody;
}

// --- Get seqno via API ---
async function getSeqno(address) {
    console.log('Getting seqno for:', address.toString());
    const result = await apiCall('runGetMethod', {
        address: address.toString(),
        method: 'seqno',
        stack: []
    });
    const seqno = parseInt(result.stack[0][1], 16);
    console.log('Seqno:', seqno);
    return seqno;
}

// --- Send Mint Transaction ---
async function sendMint(receiverAddress) {
    if (!wallet || !keyPair) {
        throw new Error('TON client not initialized');
    }

    const mintBody = buildMintBody(receiverAddress);
    const jettonMasterAddr = Address.parse(JETTON_MASTER);

    const msg = internal({
        to: jettonMasterAddr,
        value: toNano('0.06'),
        bounce: true,
        body: mintBody,
    });

    try {
        const seqno = await getSeqno(wallet.address);
        console.log('Building transfer with seqno:', seqno);

        const transfer = wallet.createTransfer({
            seqno: seqno,
            secretKey: keyPair.secretKey,
            messages: [msg]
        });

        const boc = transfer.toBoc().toString('base64');
        console.log('Sending BOC to blockchain...');

        await apiCall('sendBoc', { boc: boc });
        console.log('Transaction sent successfully');

        // Wait for confirmation
        let attempts = 0;
        const startSeqno = seqno;
        while (attempts < 30) {
            await sleep(3000);
            try {
                const newSeqno = await getSeqno(wallet.address);
                if (newSeqno > startSeqno) {
                    console.log('Transaction confirmed! New seqno:', newSeqno);
                    return true;
                }
            } catch (e) {
                console.warn('Wait error:', e.message);
            }
            attempts++;
        }

        console.log('Transaction sent but confirmation timed out');
        return true;

    } catch (error) {
        console.error('SEND MINT ERROR:', error.message);
        console.error('Full error:', error.stack);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API Endpoints ---

// Claim tokens
app.post('/api/claim', async (req, res) => {
    try {
        const { address } = req.body;

        if (!address) {
            return res.status(400).json({ error: 'Address is required' });
        }

        let parsedAddr;
        try {
            parsedAddr = Address.parse(address);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid TON address' });
        }

        const normalizedAddr = parsedAddr.toString();

        if (hasClaimed(normalizedAddr)) {
            return res.status(400).json({ error: 'Already claimed', alreadyClaimed: true });
        }

        console.log(`Minting ${CLAIM_AMOUNT} tokens to ${normalizedAddr}...`);

        const success = await sendMint(normalizedAddr);

        if (success) {
            recordClaim(normalizedAddr, null);
            return res.json({
                success: true,
                amount: CLAIM_AMOUNT,
                message: `${CLAIM_AMOUNT} jettokens sent to your wallet!`
            });
        } else {
            return res.status(500).json({ error: 'Mint transaction failed' });
        }

    } catch (error) {
        console.error('Claim error:', error);
        return res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

// Check claim status
app.get('/api/status/:address', async (req, res) => {
    try {
        const { address } = req.params;
        let parsedAddr;
        try {
            parsedAddr = Address.parse(address);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid TON address' });
        }

        const normalizedAddr = parsedAddr.toString();
        const claimed = hasClaimed(normalizedAddr);

        res.json({
            address: normalizedAddr,
            claimed: claimed,
            claimAmount: CLAIM_AMOUNT
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        jettonMaster: JETTON_MASTER,
        claimAmount: CLAIM_AMOUNT,
        network: NETWORK,
        totalClaims: loadClaims().claims.length
    });
});

// --- Start Server ---
async function start() {
    await initTonClient();
    app.listen(PORT, () => {
        console.log(`\n🚀 Jettoken Airdrop Backend running on port ${PORT}`);
        console.log(`   Health: http://localhost:${PORT}/api/health`);
        console.log(`   Claim:  POST http://localhost:${PORT}/api/claim`);
        console.log(`   Status: GET  http://localhost:${PORT}/api/status/:address`);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
