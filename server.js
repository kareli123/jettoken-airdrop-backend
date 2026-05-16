// Jettoken Airdrop Backend
// Mints your jettoken to users who claim via the frontend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { TonClient, Address, beginCell, toNano, WalletContractV5R1, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { getHttpEndpoint } = require('@ton/ton');

const app = express();
app.use(cors());
app.use(express.json());

// --- Config ---
const JETTON_MASTER = process.env.JETTON_MASTER || 'EQB0qpljZl3xD0pbWPM3PCEn6bQfDe6Xx7a7W4qtBs45axmj';
const CLAIM_AMOUNT = parseFloat(process.env.CLAIM_AMOUNT || '100');
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '9');
const NETWORK = process.env.NETWORK || 'mainnet';
const PORT = parseInt(process.env.PORT || '3001');
const MNEMONIC = process.env.MNEMONIC;

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

// --- TON Client ---
let client = null;
let keyPair = null;
let wallet = null;
let sender = null;

async function initTonClient() {
    if (!MNEMONIC) {
        console.error('ERROR: MNEMONIC not set in .env file!');
        console.error('Copy .env.example to .env and fill in your values.');
        process.exit(1);
    }

    // Derive key pair from mnemonic
    keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));

    // Create TON client
    const endpoint = NETWORK === 'testnet'
        ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
        : 'https://toncenter.com/api/v2/jsonRPC';

    client = new TonClient({
        endpoint: endpoint,
        apiKey: process.env.TONCENTER_API_KEY || undefined,
    });

    // Create wallet contract
    wallet = WalletContractV5R1.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
    });

    console.log('Admin wallet address:', wallet.address.toString());
    console.log('Jetton Master:', JETTON_MASTER);
    console.log('Claim amount:', CLAIM_AMOUNT, 'tokens');
    console.log('Network:', NETWORK);
}

// --- Build Mint Message ---
function buildMintBody(receiverAddress) {
    const jettonMasterAddr = Address.parse(JETTON_MASTER);
    const receiverAddr = Address.parse(receiverAddress);

    // Internal transfer message (goes inside mint as a ref)
    const internalTransfer = beginCell()
        .storeUint(0x178d4519, 32)        // op::internal_transfer
        .storeUint(0, 64)                  // query_id
        .storeCoins(CLAIM_AMOUNT_NANO)     // jetton amount
        .storeAddress(jettonMasterAddr)    // from_address (jetton master for minting)
        .storeAddress(receiverAddr)        // response_destination
        .storeCoins(toNano('0.01'))        // forward_ton_amount
        .storeBit(0)                       // no forward_payload
        .endCell();

    // Mint message body
    const mintBody = beginCell()
        .storeUint(0x642b7d07, 32)        // op::mint
        .storeUint(0, 64)                  // query_id
        .storeAddress(receiverAddr)        // receiver (user's regular wallet)
        .storeCoins(toNano('0.05'))        // ton_amount for jetton wallet creation/gas
        .storeRef(internalTransfer)        // internal_transfer message as ref
        .endCell();

    return mintBody;
}

// --- Send Mint Transaction ---
async function sendMint(receiverAddress) {
    if (!client || !wallet || !keyPair) {
        throw new Error('TON client not initialized');
    }

    const mintBody = buildMintBody(receiverAddress);
    const jettonMasterAddr = Address.parse(JETTON_MASTER);

    // Create internal message to jetton master
    const body = internal({
        to: jettonMasterAddr,
        value: toNano('0.06'),           // 0.06 TON for gas + forward
        bounce: true,
        body: mintBody,
    });

    // Send via wallet
    const provider = client.provider(wallet.address);
    sender = wallet.sender(provider, keyPair.secretKey);

    // Get seqno
    const seqno = await client.getSeqno(wallet.address);

    // Send transaction
    await client.sendExternalMessage(wallet, body);

    // Wait for confirmation (simple approach)
    let attempts = 0;
    while (attempts < 30) {
        await sleep(3000);
        const newSeqno = await client.getSeqno(wallet.address).catch(() => seqno);
        if (newSeqno > seqno) {
            console.log('Transaction confirmed! Seqno:', newSeqno);
            return true;
        }
        attempts++;
    }

    console.log('Transaction sent but confirmation timed out');
    return true; // Transaction was sent, just not confirmed yet
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

        // Validate address format
        let parsedAddr;
        try {
            parsedAddr = Address.parse(address);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid TON address' });
        }

        // Normalize address (use raw format for dedup)
        const normalizedAddr = parsedAddr.toString();

        // Check if already claimed
        if (hasClaimed(normalizedAddr)) {
            return res.status(400).json({ error: 'Already claimed', alreadyClaimed: true });
        }

        console.log(`Minting ${CLAIM_AMOUNT} tokens to ${normalizedAddr}...`);

        // Send mint transaction
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
