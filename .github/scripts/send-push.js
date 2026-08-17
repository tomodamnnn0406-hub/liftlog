// Sends a Web Push notification to every registered Lift Log device.
// Run by .github/workflows/push-notify.yml — see that file for the secrets it needs.
const fs      = require('fs');
const webpush = require('web-push');

const PUBLIC_KEY = 'BJlgTaTpwjfkHTV6KLOA-53_NYLOKTMoAJ1Jo62Kc4sPZgEPUabV8QI8S2IyLj28bPhVQ1DPGAvUB2oggD61NeE';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const RAW_SUBS    = process.env.PUSH_SUBSCRIPTION;
const KIND        = process.env.KIND || 'test';

// A missing key is a setup mistake, not a normal state — fail loudly, otherwise
// the run goes green and it looks like the notification was delivered.
if (!PRIVATE_KEY) {
  console.log('::error::VAPID_PRIVATE_KEY secret is not set. Add it under Settings → Secrets and variables → Actions.');
  process.exit(1);
}
if (!RAW_SUBS) {
  console.log('::error::PUSH_SUBSCRIPTION secret is not set. Copy the device key from Lift Log → Settings → Background push.');
  process.exit(1);
}

let subs;
try {
  const parsed = JSON.parse(RAW_SUBS);
  subs = Array.isArray(parsed) ? parsed : [parsed];
} catch (e) {
  console.error('PUSH_SUBSCRIPTION is not valid JSON:', e.message);
  process.exit(1);
}

webpush.setVapidDetails('mailto:tomodamnnn0406@gmail.com', PUBLIC_KEY, PRIVATE_KEY);

// The version we just deployed, so the notification can name it.
let version = 0;
try { version = JSON.parse(fs.readFileSync('version.json', 'utf8')).version || 0; } catch (e) {}

// Japanese copy — the app is used in Japanese. The service worker builds the
// 'unsaved' text itself, because only the device knows if a draft exists.
const PAYLOADS = {
  update:  { title: 'Lift Log がアップデートされました',
             body:  `バージョン ${version} が利用可能です — タップして更新`,
             view:  'dashboard' },
  goal:    { title: '新しい月、新しい目標 🎯',
             body:  '今月の目標を設定して、モチベーションを保ちましょう。',
             view:  'goals' },
  unsaved: { title: '未保存のワークアウト', body: '', view: 'log' },
  test:    { title: 'Lift Log', body: 'プッシュ通知のテストです 🔔', view: 'dashboard' }
};

const payload = JSON.stringify({ kind: KIND, lang: 'ja', version, ...PAYLOADS[KIND] });

(async () => {
  let sent = 0, gone = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 12, urgency: 'normal' });
      sent++;
      console.log('✅ sent to', String(sub.endpoint).slice(0, 60) + '…');
    } catch (err) {
      // 404/410 mean the browser dropped this subscription — it needs re-pasting.
      if (err.statusCode === 404 || err.statusCode === 410) {
        gone++;
        console.log('⚠️  subscription expired (' + err.statusCode + ') — re-copy the device key from the app');
      } else {
        console.error('❌ push failed:', err.statusCode, err.body || err.message);
      }
    }
  }
  const summary = `${KIND}: ${sent} sent, ${gone} expired, ${subs.length} total`;
  console.log('\n' + summary);
  // Surface the result on the run page so "Success" can't be mistaken for "delivered".
  try {
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `### Push: ${KIND}\n\n- **Sent:** ${sent}\n- **Expired:** ${gone}\n- **Registered devices:** ${subs.length}\n`);
    }
  } catch (e) {}
  if (sent === 0) {
    console.log('::error::No notification was delivered. ' +
      (gone ? 'Every subscription has expired — re-copy the device key from the app.'
            : 'Check the errors above.'));
    process.exit(1);
  }
  if (gone) console.log('::warning::' + gone + ' subscription(s) expired and should be re-pasted.');
  process.exit(0);
})();
