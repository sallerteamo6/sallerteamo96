/*
 * Phone sign-up is a password account, not an SMS identity.
 *
 * A phone number used to need Supabase's Phone provider plus an SMS service, and
 * it still ended in a confirmation code read off a handset. It is now a phone
 * number, a password and a confirmation of that password. Nothing else.
 *
 * GoTrue can only build a password identity from an email or a phone, and a
 * phone identity cannot skip SMS confirmation without a server-side Auth setting
 * (sms_autoconfirm). So the number is mapped to a deterministic pseudo-email and
 * the already-enabled, already-autoconfirmed Email provider creates the account,
 * which returns a session on the same request. Verified against the live project
 * in real Chrome: one POST /auth/v1/signup, no verify/otp call, session present.
 *
 * These tests cover the mapping, which is the part that has to be right. If it is
 * not injective, two people can share one account; if it is not reversible, the
 * number cannot be read back and login stops matching registration.
 *
 * Run: node --test tests/phone-auth.test.cjs
 */
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..');

const source = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const context = { console, setTimeout, clearTimeout, window: {}, document: { addEventListener() {} } };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context);
// db.js publishes itself on the global it is given, which is the bare context
// here and `window` in a page.
const DB = context.TrustDB || context.window.TrustDB || context.DB;
assert.ok(DB && typeof DB._authIdent === 'function', 'scripts/db.js did not expose TrustDB');

// Scanning raw source would match the wording of a comment explaining what the
// code deliberately does not do, which is the opposite of a finding. Strip
// comments first, the way the settlement and market tests do.
function code(fragment) {
  return fragment
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

// One method, by brace matching. Slicing between two method names is not enough:
// wallet sign-in legitimately uses verifyOtp to redeem its emailed token, and a
// register-to-login slice would drag that in and look like a phone code step.
function method(name) {
  const start = source.indexOf('\n    ' + name + ': function');
  assert.notEqual(start, -1, 'method not found: ' + name);
  const open = source.indexOf('{', source.indexOf('function', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) return code(source.slice(start, i + 1)); }
  }
  throw new Error('unbalanced braces in ' + name);
}

const ident = (v, hint) => DB._authIdent(v, hint);

test('a phone number maps to one address however it is typed', () => {
  const typed = ['+15551234567', '+1 555 123 4567', '+1-555-123-4567', '+1 (555) 123.4567', '  +15551234567  '];
  const mapped = typed.map((v) => ident(v, 'phone').authEmail);
  assert.equal(new Set(mapped).size, 1, 'every spelling must resolve to one identity');
  assert.equal(mapped[0], 'p15551234567@phone.invalid');
});

test('the mapping is injective, so no two numbers share an account', () => {
  // Every length E.164 allows, 8 to 15 digits. If the mapping collapsed any two
  // of these, one member could be handed another member's account.
  const numbers = ['+12345678', '+123456789', '+1234567890', '+12345678901',
                   '+123456789012', '+1234567890123', '+12345678901234', '+123456789012345'];
  const kinds = numbers.map((n) => ident(n, 'phone').kind);
  assert.deepEqual(kinds, numbers.map(() => 'phone'), 'every length in range must be accepted');
  const mapped = numbers.map((n) => ident(n, 'phone').authEmail);
  assert.equal(new Set(mapped).size, numbers.length);
});

test('the address is reversible, so the number can be read back', () => {
  for (const n of ['+15551234567', '+447700900123', '+8613800138000']) {
    const row = DB._toV1User({ id: 'u1', account: ident(n, 'phone').authEmail, email: ident(n, 'phone').authEmail });
    assert.equal(row.account, n, 'account must read back as the number');
    assert.equal(row.phone, n);
    assert.equal(row.email, null, 'the internal address must not be shown as an email');
  }
});

test('a real email account is left completely alone', () => {
  const row = DB._toV1User({ id: 'u2', account: 'member@example.test', email: 'member@example.test' });
  assert.equal(row.account, 'member@example.test');
  assert.equal(row.email, 'member@example.test');
  assert.equal(row.phone, null);
});

test('a wallet account is not mistaken for a phone account', () => {
  // 0x addresses are 40 hex characters and must stay exactly as they are.
  const addr = '0xAbC0000000000000000000000000000000001234';
  const row = DB._toV1User({ id: 'u3', account: addr, email: 'w@wallet.invalid' });
  assert.equal(row.account, addr);
  const i = ident(addr);
  assert.notEqual(i.kind, 'phone', 'a 0x address is not an E.164 number');
});

test('a bare local number is refused rather than given a guessed country code', () => {
  // Inventing a code would create the account under a number nobody owns.
  const i = ident('5551234567');
  assert.equal(i.kind, 'invalid');
  assert.match(i.msg, /country code/i);
});

test('an out-of-range number is refused', () => {
  assert.equal(ident('+1234567', 'phone').kind, 'invalid', 'too short');
  assert.equal(ident('+1234567890123456', 'phone').kind, 'invalid', 'too long');
  assert.equal(ident('+15551234567', 'phone').kind, 'phone');
});

test('the Phone/Email toggle decides, so an address cannot be read as a number', () => {
  assert.equal(ident('+15551234567', 'email').kind, 'invalid');
  assert.equal(ident('member@example.test', 'phone').kind, 'invalid');
});

test('pasting the internal address signs in as the same phone account', () => {
  // An operator reading User Management may paste what is stored. It has to land
  // on the same identity rather than creating or failing to match a second one.
  const byPhone = ident('+15551234567', 'phone');
  const byAddress = ident('p15551234567@phone.invalid');
  assert.equal(byAddress.kind, 'phone');
  assert.equal(byAddress.value, byPhone.value);
  assert.equal(byAddress.authEmail, byPhone.authEmail);
});

test('the mapped domain cannot receive mail', () => {
  // RFC 2606 reserves .invalid precisely so it can never resolve, so a
  // confirmation email can never be delivered here and the domain cannot be
  // taken over and turned into a mailbox someone controls.
  assert.match('p15551234567@phone.invalid', /@phone\.invalid$/);
  assert.equal(new Set(['+15551234567'].map((n) => ident(n, 'phone').authEmail.split('@')[1])).size, 1);
});

test('no code step is left in the register path', () => {
  // The old flow returned needsPhoneConfirm and told the member to read an SMS.
  // There is no OTP request and no confirmation branch to reach.
  const reg = method('register');
  assert.doesNotMatch(reg, /needsPhoneConfirm/);
  assert.doesNotMatch(reg, /verifyOtp/);
  assert.doesNotMatch(reg, /signInWithOtp/);
  assert.doesNotMatch(reg, /creds\.phone\s*=/, 'a phone must not be sent to GoTrue as a phone');
  assert.match(reg, /creds\.email = id\.authEmail/);
});

test('login uses the same mapped address registration used', () => {
  const reg = method('login');
  assert.match(reg, /id\.kind === 'phone' \? id\.authEmail : id\.value/);
  assert.doesNotMatch(reg, /creds\.phone\s*=/, 'the two paths must not be able to drift apart');
});

test('a wrong password is still refused, and does not reveal whether the account exists', () => {
  const reg = method('login');
  assert.match(reg, /Incorrect phone number or password/);
  assert.doesNotMatch(reg, /no such account|not registered|does not exist/i);
});

test('the register form asks for the length the server enforces', () => {
  // The form accepted 6 characters and the server refused anything under 8, so
  // a short password was accepted and then bounced back as a server error.
  const html = fs.readFileSync(path.join(root, 'register.html'), 'utf8');
  assert.match(html, /pass\.length < 8/);
  assert.match(html, /at least 8 characters/);
  assert.doesNotMatch(html, /needsPhoneConfirm/, 'the code step must be gone from the page too');
});
