require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ── Environment variables (set these in Render, never hardcode them) ──
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // your private admin group's chat ID

const WALLETS = {
  BTC: process.env.WALLET_BTC || 'SET_WALLET_BTC_IN_ENV',
  'USDT(ERC20)': process.env.WALLET_USDT_ERC20 || 'SET_WALLET_USDT_ERC20_IN_ENV',
  ETH: process.env.WALLET_ETH || 'SET_WALLET_ETH_IN_ENV',
};

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars. Set BOT_TOKEN, SUPABASE_URL, SUPABASE_KEY.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── In-memory session store: tracks each user's spot in the deal wizard ──
// This resets if the bot restarts. Fine for a single free-tier instance.
const sessions = new Map();
function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, { step: null, data: {} });
  return sessions.get(userId);
}
function resetSession(userId) {
  sessions.set(userId, { step: null, data: {} });
}

function generateDealId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 7; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `SD-${id}`;
}

function calcFee(amount) {
  return amount <= 100 ? 5 : +(amount * 0.05).toFixed(2);
}

// ── Static text ──
const mainMenu = Markup.keyboard([
  ['🤝 Start Deal'],
  ['📋 My Transactions'],
  ['⚖️ Support'],
  ['📜 Terms & Rules'],
]).resize();

const WELCOME_TEXT = `🛡️ Welcome to your Escrow Bot!

We help buyers and sellers complete safe, secure transactions.

💼 How it works:
1️⃣ Buyer creates a deal & sends payment
2️⃣ Buyer uploads payment proof
3️⃣ Admin approves payment
4️⃣ Seller submits completion proof + wallet
5️⃣ Admin releases funds ✅

🔒 Funds are protected until the admin releases them.

Use the menu below to get started:

💵 ESCROW FEE
• $5.00 flat for deals of $100 or less
• 5.0% for deals over $100

For full terms and conditions, select 'Terms & Rules' in the menu.`;

const TERMS_TEXT = `📜 Escrow Bot — Terms & Rules

By using this escrow bot, both buyer and seller agree to the following terms and conditions.

1. Neutral Middleman
The escrow bot acts only as a neutral middleman between both parties during transactions.

2. Deal Confirmation
Before funds are deposited, both buyer and seller must clearly agree on:
• Product/Service
• Amount
• Payment Method
• Delivery Terms

3. Prohibited Activities
This bot may NOT be used for:
• Fraud or scams
• Stolen accounts or stolen goods
• Illegal products/services
• Money laundering
• Any activity that violates laws or Telegram policies
Any prohibited transaction may be canceled without notice.

4. Escrow Deposit
Funds must be fully deposited into escrow before the seller begins delivery.

5. Release of Funds
Funds will only be released when:
• The buyer confirms delivery, OR
• Staff/Admin resolves the dispute

6. Disputes
In case of a dispute:
• Both parties must provide valid proof/screenshots
• Admin decisions are final
• Fake or edited evidence may result in a permanent ban

7. Refund Policy
Refunds are only issued if:
• The seller fails to deliver, OR
• Both parties agree to cancel the deal
Network or transaction fees may not be refundable.

8. User Responsibility
Users are responsible for double-checking wallet addresses, verifying usernames before sending funds, and keeping their Telegram account secure. The bot is not responsible for losses caused by user mistakes.

9. Fees
• $5.00 flat for deals of $100 or less
• 5.0% for deals over $100

10. Right to Refuse Service
The bot/admin reserves the right to refuse or cancel any transaction suspected of fraud, abuse, or suspicious activity.

⚠️ Warning: Never send funds outside the escrow bot. Admins will never DM first.`;

// ── /start and menu ──
bot.start((ctx) => {
  resetSession(ctx.from.id);
  ctx.reply(WELCOME_TEXT, mainMenu);
});

bot.hears('🤝 Start Deal', (ctx) => {
  const session = getSession(ctx.from.id);
  session.step = 'awaiting_seller_username';
  session.data = { buyer_id: String(ctx.from.id), buyer_username: ctx.from.username || '' };
  ctx.reply("🤝 Create a New Escrow Deal\n\nStep 1/5 — Enter the seller's Telegram username (without @):");
});

bot.hears('📋 My Transactions', async (ctx) => {
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .eq('buyer_id', String(ctx.from.id))
    .order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return ctx.reply('⚠️ Could not load your transactions right now.');
  }
  if (!data || data.length === 0) {
    return ctx.reply('You have no transactions yet.');
  }
  const list = data.map((d) => `• ${d.id} — ${d.amount} ${d.currency} — ${d.status}`).join('\n');
  ctx.reply(`📋 Your Transactions:\n\n${list}`);
});

bot.hears('⚖️ Support', (ctx) => {
  ctx.reply('⚖️ Support\n\nIf you need help:\n• Contact @Legitservices_1\n• Provide your transaction ID\n\n⏱️ Response time: within 24 hours.');
});

bot.hears('📜 Terms & Rules', (ctx) => {
  ctx.reply(TERMS_TEXT);
});

// ── Text handler: drives the wizard steps ──
bot.on('text', async (ctx, next) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();

  switch (session.step) {
    case 'awaiting_seller_username':
      session.data.seller_username = text.replace('@', '');
      session.step = 'awaiting_amount';
      return ctx.reply('Step 2/5 — Enter the deal amount (numbers only, e.g. 150):');

    case 'awaiting_amount': {
      const cleaned = text.replace(/[^0-9.]/g, '');
      const amount = parseFloat(cleaned);
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Please enter a valid number, e.g. 150');
      }
      const fee = calcFee(amount);
      session.data.amount = amount;
      session.data.fee = fee;
      session.step = 'awaiting_currency';
      return ctx.reply(
        `✅ Amount: $${amount.toFixed(2)}\n📊 Escrow Fee (${amount <= 100 ? 'flat' : '5.0%'}): $${fee.toFixed(2)}\n\nStep 3/5 — Choose the currency:`,
        Markup.inlineKeyboard([
          [Markup.button.callback('USD', 'currency_USD'), Markup.button.callback('EUR', 'currency_EUR'), Markup.button.callback('USDT', 'currency_USDT')],
        ])
      );
    }

    case 'awaiting_description':
      session.data.description = text;
      session.step = 'awaiting_payment_method';
      return ctx.reply(
        'Step 5/5 — Choose the payment method:',
        Markup.inlineKeyboard([
          [Markup.button.callback('PayPal', 'pay_PayPal'), Markup.button.callback('MasterCard', 'pay_MasterCard')],
          [Markup.button.callback('BTC', 'pay_BTC')],
          [Markup.button.callback('USDT(ERC20)', 'pay_USDT(ERC20)')],
          [Markup.button.callback('ETH', 'pay_ETH')],
        ])
      );

    case 'awaiting_dispute_reason':
      session.data.dispute_reason = text;
      session.step = 'awaiting_dispute_evidence';
      return ctx.reply('📎 Upload Evidence\n\nSend a photo/screenshot as evidence for your dispute.');

    default:
      return next();
  }
});

// ── Currency selection ──
bot.action('currency_USD', (ctx) => handleCurrency(ctx, 'USD'));
bot.action('currency_EUR', (ctx) => handleCurrency(ctx, 'EUR'));
bot.action('currency_USDT', (ctx) => handleCurrency(ctx, 'USDT'));

async function handleCurrency(ctx, currency) {
  const session = getSession(ctx.from.id);
  session.data.currency = currency;
  session.step = 'awaiting_description';
  await ctx.answerCbQuery();
  await ctx.reply('Step 4/5 — Enter a deal description (what is being sold/bought):');
}

// ── Payment method selection ──
bot.action(['pay_PayPal', 'pay_MasterCard'], async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Use another payment method — we are not handling more deals with this method right now‼️');
});

bot.action(['pay_BTC', 'pay_USDT(ERC20)', 'pay_ETH'], async (ctx) => {
  const session = getSession(ctx.from.id);
  const method = ctx.match[0].replace('pay_', '');
  const wallet = WALLETS[method];
  const dealId = generateDealId();
  session.data.payment_method = method;
  session.data.id = dealId;

  const { error } = await supabase.from('deals').insert({
    id: dealId,
    buyer_id: session.data.buyer_id,
    seller_username: session.data.seller_username,
    amount: session.data.amount,
    fee: session.data.fee,
    currency: session.data.currency,
    description: session.data.description,
    payment_method: method,
    wallet_address: wallet,
    status: 'pending_payment',
  });

  if (error) {
    console.error(error);
    await ctx.answerCbQuery();
    return ctx.reply('⚠️ Something went wrong creating your deal. Please try again with 🤝 Start Deal.');
  }

  await ctx.answerCbQuery();
  await ctx.reply(wallet);
  await ctx.reply(
    `🔖 Transaction ID: ${dealId}\n💳 Payment Method: *${method}*\n💰 Amount: *${session.data.amount.toFixed(1)} ${session.data.currency}*\n📊 Escrow Fee: $${session.data.fee}\n📝 Description: ${session.data.description}\n👤 Seller: @${session.data.seller_username}\n\n⚠️ Double check the network before sending funds.\n\nAfter payment:\n1. Send the funds\n2. Tap "I Have Paid"\n3. Upload your payment screenshot`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ I Have Paid', `paid_${dealId}`)],
        [Markup.button.callback('⚠️ Open Dispute', `dispute_${dealId}`)],
        [Markup.button.callback('❌ Cancel Deal', `cancel_${dealId}`)],
      ]),
    }
  );
  session.step = null;
});

// ── Post-deal actions ──
bot.action(/^paid_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  const session = getSession(ctx.from.id);
  session.step = 'awaiting_payment_proof';
  session.data.activeDeal = dealId;
  await ctx.answerCbQuery();
  await ctx.reply(`✅ Upload Payment Proof\n\nTransaction: ${dealId}\n\nPlease send a screenshot or photo of your payment confirmation.`);
});

bot.action(/^dispute_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  const session = getSession(ctx.from.id);
  session.step = 'awaiting_dispute_reason';
  session.data.activeDeal = dealId;
  await ctx.answerCbQuery();
  await ctx.reply(`⚠️ Open a Dispute\n\nTransaction: ${dealId}\n\nPlease describe the reason for the dispute:`);
});

bot.action(/^cancel_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    `❓ Are you sure you want to cancel deal ${dealId}?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('Yes, cancel', `confirmcancel_${dealId}`)],
      [Markup.button.callback('No, keep', `keep_${dealId}`)],
    ])
  );
});

bot.action(/^confirmcancel_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  await supabase.from('deals').update({ status: 'cancelled' }).eq('id', dealId);
  await ctx.answerCbQuery('Deal cancelled');
  await ctx.reply(`Deal ${dealId} has been cancelled.`);
});

bot.action(/^keep_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Deal kept active');
});

// ── Photo handler: payment proof or dispute evidence ──
bot.on('photo', async (ctx) => {
  const session = getSession(ctx.from.id);
  const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const dealId = session.data.activeDeal;

  if (session.step === 'awaiting_payment_proof' && dealId) {
    const { data: dealRow } = await supabase
      .from('deals')
      .update({ status: 'proof_submitted', payment_proof_url: photoId })
      .eq('id', dealId)
      .select()
      .single();

    await ctx.reply(
      `✅ Payment proof submitted!\n\nTransaction ${dealId} status: 🧾\n*Awaiting Admin Approval*\n\nAn admin will confirm the payment, then ask the seller for their completion proof + wallet.\n\nAfter admin approval, you will be asked to send:\n• a screenshot/photo proving the service was completed\n• your payout wallet address`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚠️ Open Dispute', `dispute_${dealId}`)],
          [Markup.button.callback('❌ Cancel Deal', `cancel_${dealId}`)],
        ]),
      }
    );

    if (ADMIN_CHAT_ID) {
      const amountText = dealRow ? `${dealRow.amount} ${dealRow.currency}` : '';
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, photoId, {
        caption: `🔔 Payment Proof Submitted\n\nTransaction: ${dealId}\n💰 Amount: ${amountText}\n\nThe buyer has submitted payment proof.\nPlease confirm, then ask the seller for completion proof + payout wallet.`,
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Approve', `approve_${dealId}`), Markup.button.callback('❌ Reject', `reject_${dealId}`)],
        ]),
      });
    }
    session.step = null;
    return;
  }

  if (session.step === 'awaiting_dispute_evidence' && dealId) {
    await supabase.from('deals').update({ status: 'disputed', dispute_reason: session.data.dispute_reason }).eq('id', dealId);
    await ctx.reply('Your dispute has been submitted. An admin will review it shortly.');

    if (ADMIN_CHAT_ID) {
      await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, photoId, {
        caption: `⚠️ Dispute opened\nDeal: ${dealId}\nBuyer: @${ctx.from.username || ctx.from.id}\nReason: ${session.data.dispute_reason}`,
      });
    }
    session.step = null;
    return;
  }
});

// ── Admin approve/reject (used inside the private admin group) ──
bot.action(/^approve_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  await supabase.from('deals').update({ status: 'approved' }).eq('id', dealId);
  await ctx.answerCbQuery('Approved');
  await ctx.editMessageCaption(`✅ Approved — Deal ${dealId}`);
});

bot.action(/^reject_(.+)$/, async (ctx) => {
  const dealId = ctx.match[1];
  await supabase.from('deals').update({ status: 'rejected' }).eq('id', dealId);
  await ctx.answerCbQuery('Rejected');
  await ctx.editMessageCaption(`❌ Rejected — Deal ${dealId}`);
});

// ── Tiny HTTP server so Render's port health-check passes ──
// This does not affect how the bot works — Telegram polling stays the same.
// Render just needs to see *something* answering on a port to mark the deploy healthy.
const http = require('http');
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Escrow bot is alive.');
  })
  .listen(PORT, () => {
    console.log(`Health check server listening on port ${PORT}`);
  });

bot.launch();
console.log('Escrow bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
