import express from "express";
import { ethers } from "ethers";
import axios from "axios";
import dotenv from "dotenv";
import qs from "qs";
import crypto from "crypto";

dotenv.config();

/* ================= CONFIG ================= */
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TARGET_WALLET = process.env.TARGET_WALLET;
const CHAIN_ID = 8453; // Base

// Validate required env vars
if (!TARGET_WALLET) {
  throw new Error("TARGET_WALLET is required in .env");
}
if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY is required in .env");
}
if (!process.env.RPC_URL) {
  throw new Error("RPC_URL is required in .env");
}
if (!process.env.ZEROX_API_KEY) {
  throw new Error("ZEROX_API_KEY is required in .env");
}

// Settings
const BUY_AMOUNT_ETH = process.env.BUY_AMOUNT_ETH || "0.0001";
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS || 5000;
const MAX_FEE_PER_GAS = process.env.MAX_FEE_PER_GAS || "200000000";
const MAX_PRIORITY_FEE = process.env.MAX_PRIORITY_FEE || "50000000";

// Blacklist tokens
const BLACKLIST_TOKENS = new Set(
  (process.env.BLACKLIST_TOKENS || "").split(",").map(addr => addr.toLowerCase().trim()).filter(Boolean)
);

// Provider & Wallet (với timeout cao hơn)
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, {
  staticNetwork: true,
  pollingInterval: 1000,
});
provider._getConnection().timeout = 30000; // 30 second timeout
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Alchemy webhook signing key (optional)
const ALCHEMY_SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY || "";

console.log(`🤖 Alchemy Copy Trade Bot Starting...`);
console.log(`👁️  Monitoring: ${TARGET_WALLET}`);
console.log(`💰 Your wallet: ${wallet.address}`);
console.log(`💵 Buy amount: ${BUY_AMOUNT_ETH} ETH per trade`);
console.log(`📊 Slippage: ${SLIPPAGE_BPS / 100}%`);
console.log(`⛽ Max fee: ${Number(MAX_FEE_PER_GAS) / 1e9} gwei | Priority: ${Number(MAX_PRIORITY_FEE) / 1e9} gwei\n`);

/* ================= UTILS ================= */

// Verify Alchemy signature
function verifySignature(body, signature) {
  if (!ALCHEMY_SIGNING_KEY) return true;

  const hash = crypto
    .createHmac("sha256", ALCHEMY_SIGNING_KEY)
    .update(JSON.stringify(body))
    .digest("hex");

  return `sha256=${hash}` === signature;
}

// Check if this is a real swap (EXACTLY 1 UNIQUE token IN and 1 UNIQUE token OUT - for safety)
function isRealSwap(allActivity) {
  const transfers = Array.isArray(allActivity) ? allActivity : [];

  // CHỈ LẤY TOKEN TRANSFERS (category === "token")
  const tokenTransfers = transfers.filter(t => t.category === "token");

  // Find ALL token OUT (from target wallet)
  const tokensOut = tokenTransfers.filter(
    t => t.fromAddress?.toLowerCase() === TARGET_WALLET.toLowerCase()
  );

  // Find ALL token IN (to target wallet)
  const tokensIn = tokenTransfers.filter(
    t => t.toAddress?.toLowerCase() === TARGET_WALLET.toLowerCase()
  );

  // Deduplicate by token address (Alchemy có thể gửi duplicate)
  const uniqueTokensOut = [...new Map(tokensOut.map(t => {
    const addr = (t.rawContract?.address || t.tokenAddress || '').toLowerCase();
    return [addr, t];
  })).values()];

  const uniqueTokensIn = [...new Map(tokensIn.map(t => {
    const addr = (t.rawContract?.address || t.tokenAddress || '').toLowerCase();
    return [addr, t];
  })).values()];

  // SAFETY: Chỉ chấp nhận ĐÚNG 1 UNIQUE token IN và 1 UNIQUE token OUT
  // Nhiều hơn có thể là attack/fake bundle
  if (uniqueTokensOut.length !== 1 || uniqueTokensIn.length !== 1) {
    return null;
  }

  const tokenOut = tokensOut[0];
  const tokenIn = tokensIn[0];

  const tokenInAddress = tokenIn.rawContract?.address || tokenIn.tokenAddress;

  if (!tokenInAddress || tokenInAddress === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  // Check blacklist
  if (BLACKLIST_TOKENS.has(tokenInAddress.toLowerCase())) {
    return null;
  }

  // Must be ERC20 token
  if (tokenIn.category !== "token") {
    return null;
  }

  return {
    tokenOut: tokenOut.asset,
    tokenIn: tokenIn.asset,
    amountOut: tokenOut.value,
    amountIn: tokenIn.value,
    tokenInAddress: tokenInAddress,
  };
}

/* ================= 0x SWAP LOGIC ================= */

async function get0xQuote(buyToken, sellAmountWei) {
  const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

  const params = {
    chainId: CHAIN_ID,
    sellToken: NATIVE_ETH,
    buyToken: buyToken,
    sellAmount: sellAmountWei.toString(),
    taker: wallet.address,
    slippageBps: SLIPPAGE_BPS,
  };

  const url = "https://api.0x.org/swap/allowance-holder/quote?" + qs.stringify(params);

  const res = await axios.get(url, {
    headers: {
      "0x-api-key": process.env.ZEROX_API_KEY,
      "0x-version": "v2",
    },
    timeout: 3000,
  });

  return res.data;
}

async function executeSwap(buyToken, txHash) {
  try {
    const sellAmountWei = ethers.parseEther(BUY_AMOUNT_ETH);

    // Get quote from 0x
    const quote = await get0xQuote(buyToken, sellAmountWei);

    // Send transaction
    const tx = await wallet.sendTransaction({
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value,
      gasLimit: BigInt(Math.floor(Number(quote.transaction.gas) * 1.2)),
      maxFeePerGas: BigInt(MAX_FEE_PER_GAS),
      maxPriorityFeePerGas: BigInt(MAX_PRIORITY_FEE),
      type: 2,
    });

    console.log(`Your TX:   https://basescan.org/tx/${tx.hash}`);

    // Confirm in background
    tx.wait(1).then(receipt => {
      console.log(`✅ Confirmed in block ${receipt.blockNumber}`);
    }).catch(err => {
      console.error(`⚠️  TX failed: ${err.message}`);
    });

    return tx.hash;

  } catch (error) {
    console.error(`\n❌ SWAP FAILED:`, error.message);
    if (error.response?.data) {
      console.error(`   0x Error:`, JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

/* ================= WEBHOOK ENDPOINT ================= */

// Deduplicate webhooks
const processedTxs = new Set();
const TX_CACHE_TIME = 60000; // 1 minute

const webhookHandler = async (req, res) => {
  try {

    // Verify signature
    const signature = req.headers["x-alchemy-signature"];
    if (ALCHEMY_SIGNING_KEY && !verifySignature(req.body, signature)) {
      console.warn("⚠️  Invalid webhook signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Quick response
    res.status(200).json({ status: "received" });

    const { event } = req.body;

    if (!event || event.network !== "BASE_MAINNET") {
      return;
    }

    const allActivity = event.activity;
    if (!allActivity || allActivity.length === 0) {
      return;
    }

    const firstActivity = allActivity[0];
    const txHash = firstActivity.hash;

    // Deduplicate
    if (processedTxs.has(txHash)) {
      console.log(`⏭️  Skipping duplicate webhook for ${txHash}`);
      return;
    }

    processedTxs.add(txHash);
    setTimeout(() => processedTxs.delete(txHash), TX_CACHE_TIME);

    // Nếu chỉ có internal transactions HOẶC chỉ có 1 token transfer, lấy thêm từ receipt
    const tokenTransfersCount = allActivity.filter(a => a.category === "token").length;

    if (tokenTransfersCount < 2) {
      // Lấy receipt để tìm token transfers (1 retry nếu fail)
      let receipt = null;
      let retryCount = 0;
      try {
        receipt = await provider.getTransactionReceipt(txHash);
      } catch (err) {
        // Retry 1 lần sau 500ms
        retryCount = 1;
        console.log(`   ⏳ RPC failed, retrying...`);
        await new Promise(r => setTimeout(r, 500));
        try {
          receipt = await provider.getTransactionReceipt(txHash);
          console.log(`   ✅ Retry successful`);
        } catch (e) {
          console.log(`   ❌ Retry failed, using webhook data`);
        }
      }

      if (receipt) {
        // Parse Transfer events (ERC20)
        const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const tokenTransfers = [];

        for (const log of receipt.logs) {
          if (log.topics[0] === TRANSFER_TOPIC && log.topics.length >= 3) {
            const from = "0x" + log.topics[1].slice(26);
            const to = "0x" + log.topics[2].slice(26);
            const tokenAddress = log.address;

            tokenTransfers.push({
              from,
              to,
              tokenAddress,
              fromAddress: from,
              toAddress: to,
              category: "token",
              rawContract: {
                address: tokenAddress
              }
            });
          }
        }

        if (tokenTransfers.length > 0) {
          allActivity.push(...tokenTransfers);
        }
      }
    }

    // Check if this is a real swap
    const swapInfo = isRealSwap(allActivity);

    if (!swapInfo) {
      // DEBUG: Log why it's not a swap
      const tokenTransfers = allActivity.filter(a => a.category === "token");
      const tokensOut = tokenTransfers.filter(t => t.fromAddress?.toLowerCase() === TARGET_WALLET.toLowerCase());
      const tokensIn = tokenTransfers.filter(t => t.toAddress?.toLowerCase() === TARGET_WALLET.toLowerCase());

      // Deduplicate for accurate count
      const uniqueOut = [...new Set(tokensOut.map(t => (t.rawContract?.address || t.tokenAddress || '').toLowerCase()))];
      const uniqueIn = [...new Set(tokensIn.map(t => (t.rawContract?.address || t.tokenAddress || '').toLowerCase()))];

      console.log(`\n❌ Not a swap`);
      console.log(`   Unique tokens - OUT: ${uniqueOut.length} | IN: ${uniqueIn.length}`);
      if (uniqueOut.length !== 1 || uniqueIn.length !== 1) {
        console.log(`   Reason: Must be exactly 1 unique token IN and 1 unique token OUT`);
      }
      console.log(`Target TX: https://basescan.org/tx/${txHash}`);
      return;
    }

    console.log(`\n✅ SWAP DETECTED`);
    console.log(`Token IN:  ${swapInfo.tokenIn || 'N/A'}`);
    console.log(`Token OUT: ${swapInfo.tokenOut || 'N/A'}`);
    console.log(`Target TX: https://basescan.org/tx/${txHash}`);

    // Execute copy trade
    await executeSwap(swapInfo.tokenInAddress, txHash);

  } catch (error) {
    console.error("\n❌ Webhook error:", error.message);
  }
};

// Register webhook handlers
app.post("/", webhookHandler);
app.post("/webhook", webhookHandler);

/* ================= HEALTH CHECK ================= */

app.get("/health", (req, res) => {
  res.json({
    status: "running",
    target: TARGET_WALLET,
    wallet: wallet.address,
  });
});

/* ================= START SERVER ================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook endpoint: http://localhost:${PORT}/webhook\n`);
});
