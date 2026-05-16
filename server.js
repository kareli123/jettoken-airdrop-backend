// Jettoken Airdrop Backend
// Mints your jettoken to users who claim via the frontend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { TonClient, Address, beginCell, toNano, WalletContractV5R1, internal } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();
app.use(cors());
app.options('*', cors());
app.use(express.json());

// --- Config ---
const JETTON_MASTER = process.env.JETTON_MASTER || 'EQCtJiXSoQPBRMh2yijkSyTZ1iqkj-uQRKvvaAUlkFLUwsS6';
const CLAIM_AMOUNT = parseFloat(process.env.CLAIM_AMOUNT || '100');
const TOKEN_DECIMALS = parseInt(process.env.TOKEN_DECIMALS || '9');
const NETWORK = process.env.NETWORK || 'mainnet';
const PORT = parseInt(process.env.PORT || '3001');
const MNEMONIC = process.env.MNEMONIC;
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;

const API_ENDPOINT = NETWORK === 'testnet'
    ? 'https://testnet.toncenter.com/api/v2/jsonRPC'
    : 'https://toncenter.com/api/v2/jsonRPC';

const CLAIM_AMOUNT_NANO = BigInt(Math.floor(CLAIM_AMOUNT * Math.pow(10, TOKEN_DECIMALS)));

// --- Claims database ---
const CLAIMS_FILE = path.join(__dirname, 'claims.json');
function loadClaims() {
    try { if (fs.existsSync(CLAIMS_FILE)) return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); }
    catch (e) { console.error('Error loading claims:', e); }
    return { claims: [] };
}
function saveClaims(data) { fs.writeFileSync(CLAIMS_FILE, JSON.stringify(data, null, 2)); }
function hasClaimed(address) { return loadClaims().claims.some(c => c.address === address); }
function recordClaim(address) {
    const data = loadClaims();
    data.claims.push({ address, amount: CLAIM_AMOUNT, timestamp: new Date().toISOString() });
    saveClaims(data);
}

// --- TON Client ---
let client = null;
let keyPair = null;
let wallet = null;

async function initTonClient() {
    if (!MNEMONIC) { console.error('ERROR: MNEMONIC not set!'); process.exit(1); }

    keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));

    client = new TonClient({
        endpoint: API_ENDPOINT,
        apiKey: TONCENTER_API_KEY || undefined,
    });

    wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });

    const addr = wallet.address.toString();
    console.log('Admin wallet address:', addr);
    console.log('Jetton Master:', JETTON_MASTER);
    console.log('Claim amount:', CLAIM_AMOUNT);

    // Test connection
    try {
        const state = await client.getContractState(wallet.address);
        console.log('Wallet balance:', state.balance);
        console.log('Wallet state:', state.state);
    } catch (e) {
        console.error('API test failed:', e.message);
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

    return beginCell()
        .storeUint(0x642b7d07, 32)
        .storeUint(0, 64)
        .storeAddress(receiverAddr)
        .storeCoins(toNano('0.05'))
        .storeRef(internalTransfer)
        .endCell();
}

// --- Send Mint Transaction ---
async function sendMint(receiverAddress) {
    if (!client || !wallet || !keyPair) throw new Error('Not initialized');

    const mintBody = buildMintBody(receiverAddress);
    const jettonMasterAddr = Address.parse(JETTON_MASTER);

    const msg = internal({
        to: jettonMasterAddr,
        value: toNano('0.06'),
        bounce: true,
        body: mintBody,
    });

    try {
        const provider = client.provider(wallet.address);
        console.log('Getting seqno...');

        // Get seqno via getWalletInformation
        const walletInfo = await axios.get(
            API_ENDPOINT.replace('/jsonRPC', '/getWalletInformation') + '?address=' + encodeURIComponent(wallet.address.toString()),
            { headers: TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {}, timeout: 30000 }
        );
        const seqno = walletInfo.data.result?.seqno || 0;
        console.log('Seqno:', seqno);

        console.log('Building transfer...');
        const transfer = wallet.createTransfer({
            seqno: seqno,
            secretKey: keyPair.secretKey,
            messages: [msg]
        });

        console.log('Sending transaction...');
        await provider.external(transfer);
        console.log('Transaction sent!');

        // Wait confirmation
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 3000));
            try {
                const newInfo = await axios.get(
                    API_ENDPOINT.replace('/jsonRPC', '/getWalletInformation') + '?address=' + encodeURIComponent(wallet.address.toString()),
                    { headers: TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {}, timeout: 10000 }
                );
                const newSeqno = newInfo.data.result?.seqno || 0;
                if (newSeqno > seqno) {
                    console.log('Confirmed! New seqno:', newSeqno);
                    return true;
                }
            } catch (e) { /* ignore */ }
        }
        console.log('Sent (not confirmed yet)');
        return true;

    } catch (error) {
        console.error('SEND MINT ERROR:', error.message);
        throw error;
    }
}

// --- API Endpoints ---
app.post('/api/claim', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: 'Address required' });

        let parsedAddr;
        try { parsedAddr = Address.parse(address); }
        catch (e) { return res.status(400).json({ error: 'Invalid TON address' }); }

        const normalizedAddr = parsedAddr.toString();
        if (hasClaimed(normalizedAddr)) {
            return res.status(400).json({ error: 'Already claimed', alreadyClaimed: true });
        }

        console.log('Minting', CLAIM_AMOUNT, 'to', normalizedAddr);
        await sendMint(normalizedAddr);
        recordClaim(normalizedAddr);
        return res.json({ success: true, amount: CLAIM_AMOUNT, message: 'Tokens sent!' });

    } catch (error) {
        console.error('Claim error:', error.message);
        return res.status(500).json({ error: 'Internal server error: ' + error.message });
    }
});

app.get('/api/status/:address', async (req, res) => {
    try {
        const parsedAddr = Address.parse(req.params.address);
        res.json({ address: parsedAddr.toString(), claimed: hasClaimed(parsedAddr.toString()), claimAmount: CLAIM_AMOUNT });
    } catch (e) { res.status(400).json({ error: 'Invalid address' }); }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', jettonMaster: JETTON_MASTER, claimAmount: CLAIM_AMOUNT, totalClaims: loadClaims().claims.length });
});

// --- Start ---
async function start() {
    await initTonClient();
    app.listen(PORT, () => {
        console.log(`🚀 Server on port ${PORT}`);
    });
}
start().catch(err => { console.error(err); process.exit(1); });
