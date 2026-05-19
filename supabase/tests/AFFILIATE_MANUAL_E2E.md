# Manual E2E test — Affiliate ระบบครบทุกส่วน

Runbook สำหรับ test affiliate ด้วยมือเองทุกขั้นตอน — ตั้งแต่ creator สมัครจนถึง refund/dispute. กดตามลำดับ tick checkbox เมื่อ verified.

> **ไม่ใช่ automated test** — สำหรับ automated test ดูที่ `affiliate-e2e-complete.test.sql` (รันด้วย `psql -f`)

---

## 🔧 Setup ก่อนเริ่ม

### Environment
- **Supabase project**: `fymncypboeubdikpbmqc` (ap-southeast-1)
- **Dashboard**: https://supabase.com/dashboard/project/fymncypboeubdikpbmqc
- **SQL Editor**: ใช้สำหรับรัน verify queries แต่ละ step
- **Workspace frontend**: https://workspace.mediaforge.co
- **Admin panel**: https://admin.mediaforge.co
- **ERP**: (URL ที่คุณใช้)
- **Stripe Dashboard**: https://dashboard.stripe.com → toggle **test mode** มุมขวาบน

### Test accounts ที่ต้องเตรียม
- [ ] **Partner A** — creator ที่จะสมัคร affiliate (อีเมล: partner-a@test.com)
- [ ] **Partner B** — creator ที่จะถูก admin invite ตรง (อีเมล: partner-b@test.com)
- [ ] **Customer X** — ลูกค้าที่จะกดสมัครผ่าน ref ของ Partner A
- [ ] **Customer Y** — ลูกค้าที่จะ refund/dispute
- [ ] **Admin** — บัญชี admin ของ admin.mediaforge.co
- [ ] **Sales** — บัญชี sales ที่เข้า ERP ได้

### Stripe test mode setup
- [ ] เปิด Stripe test mode
- [ ] เตรียม test card: `4242 4242 4242 4242` (success), `4000 0000 0000 9995` (dispute trigger)
- [ ] CVC: `123`, Date: any future
- [ ] เช็คว่า webhook endpoint ของ `stripe-webhook` รับ events: `checkout.session.completed`, `payment_intent.succeeded`, `invoice.paid`, `charge.refunded`, `refund.*`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`

### Database baseline snapshot (ก่อนเริ่ม test)
รัน query นี้ใน SQL Editor บันทึก count ไว้ — ตอนจบ test จะ verify ว่าตัวเลขเปลี่ยนตามที่คาด:

```sql
SELECT
  (SELECT count(*) FROM public.partner_applications) AS apps,
  (SELECT count(*) FROM public.partners) AS partners,
  (SELECT count(*) FROM public.referral_codes WHERE code_type='partner_affiliate') AS codes,
  (SELECT count(*) FROM public.referrals) AS referrals,
  (SELECT count(*) FROM public.commission_events) AS commissions,
  (SELECT count(*) FROM public.payout_requests) AS payouts,
  (SELECT count(*) FROM public.affiliate_audit_log) AS audit_logs;
```

จด baseline ไว้: __________________________

---

## §1 Partner onboarding — self-serve apply→approve

### Step 1.1 — Partner A สมัคร affiliate

- [ ] **ทำ**: เข้า https://workspace.mediaforge.co ด้วย Partner A login → ไปที่หน้า affiliate program → กรอกฟอร์มสมัคร:
  - Full name: "Partner Aye"
  - Phone: `+66800000001`
  - Social URL: `https://instagram.com/partner-a`
  - Platform: instagram
  - Follower count: 1000
  - Bank name: SCB
  - Bank account no: `0123456789`
  - Bank account name: "Partner Aye"
- [ ] **คาดหวัง**: เห็น "Application submitted" toast / status = "Under review"

**Verify SQL**:
```sql
SELECT id, status, submitted_at, bank_name, bank_account_no, follower_count
FROM public.partner_applications
WHERE user_id = '<partner-a-uuid>'
ORDER BY created_at DESC LIMIT 1;
```
✓ ต้องเห็น 1 row, `status='submitted'`, `submitted_at` ตอนนี้

### Step 1.2 — Admin reject (ทดสอบ reject flow)

- [ ] **ทำ**: เข้า admin.mediaforge.co → Affiliate → Applications → เปิดของ Partner A → กด "Request more info" + ใส่ message "ขอ screenshot ของ social profile"
- [ ] **คาดหวัง**: status → `needs_info`, `needs_info_message` ตั้งค่าเรียบร้อย

**Verify SQL**:
```sql
SELECT status, needs_info_message FROM public.partner_applications
WHERE user_id = '<partner-a-uuid>';
```
✓ `status='needs_info'`, message ตามที่ใส่

### Step 1.3 — Partner A resubmit

- [ ] **ทำ**: Partner A login → resubmit application พร้อมข้อมูลเดิม
- [ ] **คาดหวัง**: status → `submitted` อีกครั้ง

### Step 1.4 — Rate limit test (ตรวจ cooldown)

- [ ] **ทำ**: Partner A ลอง resubmit ภายใน 30 นาทีหลัง submit รอบที่แล้ว
- [ ] **คาดหวัง**: error message "Your application is already in review. Please wait at least 30 minutes before resubmitting."

### Step 1.5 — Admin approve

- [ ] **ทำ**: Admin panel → กด "Approve" บน Partner A application
- [ ] **คาดหวัง**: 
  - Status: approved
  - Email สง่ confirmation ให้ Partner A (ตรวจ inbox)
  - Partner A เห็น affiliate code ในหน้า dashboard ของตัวเอง

**Verify SQL**:
```sql
SELECT
  pa.status AS app_status,
  p.commission_rate,
  p.approved_at,
  rc.code,
  rc.is_active,
  rc.discount_percent
FROM public.partner_applications pa
JOIN public.partners p ON p.user_id = pa.user_id
JOIN public.referral_codes rc ON rc.user_id = pa.user_id
WHERE pa.user_id = '<partner-a-uuid>';
```
✓ `app_status='approved'`, `commission_rate=0.30`, code ขึ้นต้นด้วย `MF-P-` 6 หลัก, `is_active=true`

จดค่าไว้:
- Partner A code: __________________________
- Partner A user_id: __________________________

---

## §2 Partner onboarding — manual create via ERP

### Step 2.1 — Admin invite Partner B ตรงผ่าน ERP

- [ ] **ทำ**: เข้า ERP → Affiliate → "Create partner" form กรอก:
  - Email: `partner-b@test.com`
  - Full name: "Partner Bee"
  - Phone: `+66800000002`
  - Commission rate: 0.30
  - Discount: 20%
  - Bank: SCB / `9876543210` / "Partner Bee"
  - Code: `MF-BEE-CUSTOM`
- [ ] **คาดหวัง**: success message + Partner B จะมี partner row + code custom

**Verify SQL**:
```sql
SELECT
  pa.status, p.commission_rate, p.tier,
  rc.code, rc.discount_percent, rc.campaign_label
FROM public.partner_applications pa
JOIN public.partners p ON p.user_id = pa.user_id
JOIN public.referral_codes rc ON rc.user_id = pa.user_id
WHERE pa.bank_account_no = '9876543210';
```
✓ `status='approved'`, `tier='creator_20'`, `code='MF-BEE-CUSTOM'`, `discount_percent=20`

### Step 2.2 — Verify Stripe coupon ถูกสร้าง

- [ ] **ทำ**: เปิด Stripe Dashboard → Coupons → ค้น `MF-BEE-CUSTOM`
- [ ] **คาดหวัง**: เห็น coupon ที่ `percent_off=20`, `duration=once`, metadata มี `affiliate_code: MF-BEE-CUSTOM`

### Step 2.3 — Upsert code อันที่ 2 ให้ Partner B (custom campaign)

- [ ] **ทำ**: ERP → upsert_affiliate_code action กรอก:
  - partner_user_id: Partner B's user_id
  - code: `MF-BEE-XMAS`
  - discount_percent: 30
  - campaign_label: "Xmas campaign"
- [ ] **คาดหวัง**: code ที่ 2 ถูกสร้าง + Stripe coupon ที่ 2

**Verify SQL**:
```sql
SELECT code, discount_percent, campaign_label, is_active
FROM public.referral_codes
WHERE user_id = '<partner-b-uuid>' AND code_type='partner_affiliate'
ORDER BY created_at;
```
✓ 2 rows: `MF-BEE-CUSTOM` (20%) + `MF-BEE-XMAS` (30%)

### Step 2.4 — Edit existing code (เพิ่ม discount)

- [ ] **ทำ**: ERP → upsert_affiliate_code ใช้ code เดิม `MF-BEE-CUSTOM` พร้อม `discount_percent=25`
- [ ] **คาดหวัง**: code เดิมถูก update เป็น 25% + Stripe coupon ถูก create ใหม่ (อันเก่ายังอยู่แต่ไม่ใช้)

### Step 2.5 — Reject foreign code (security check)

- [ ] **ทำ**: ลอง upsert_affiliate_code ด้วย code ที่ Partner A ใช้อยู่ (`MF-P-XXXXXX`) แต่ส่ง `partner_user_id` ของ Partner B
- [ ] **คาดหวัง**: error "affiliate code is already owned by another partner"

---

## §3 Customer attribution (first-touch lock)

### Step 3.1 — Customer X เข้า ref link ของ Partner A

- [ ] **ทำ**: เปิด browser private mode → เข้า `https://workspace.mediaforge.co/app/pricing?ref=<Partner-A-code>` → กดสมัครเป็น Customer X
- [ ] **คาดหวัง**: หลัง signup, referrals table มี row ผูก Customer X ↔ Partner A

**Verify SQL**:
```sql
SELECT id, referrer_user_id, referred_user_id, code_type, attribution_status, attribution_source
FROM public.referrals
WHERE referred_user_id = '<customer-x-uuid>';
```
✓ 1 row, `attribution_status='pending'` (ยังไม่จ่ายเงิน)

### Step 3.2 — First-touch lock test

- [ ] **ทำ**: Customer X (ที่ผูก Partner A อยู่แล้ว) เปิด ref link ของ Partner B → กดสมัครรอบใหม่
- [ ] **คาดหวัง**: ระบบ ignore ref ใหม่ — referrals.referred_user_id ยังคงเป็น Partner A เท่านั้น

**Verify SQL**:
```sql
SELECT count(*), array_agg(referrer_user_id) AS referrers
FROM public.referrals
WHERE referred_user_id = '<customer-x-uuid>';
```
✓ `count=1`, referrer = Partner A (ไม่ใช่ Partner B)

---

## §4 Commission accrual + 21-day hold

### Step 4.1 — Customer X จ่ายเงินครั้งแรก

- [ ] **ทำ**: Customer X → ซื้อ subscription (เช่น Pro plan ราคา 1000 THB) ด้วย Stripe test card `4242 4242 4242 4242`
- [ ] **คาดหวัง**: payment success + commission_events ถูกสร้าง

**Verify SQL** (รันหลังจ่ายเงิน 5 วินาที):
```sql
SELECT
  id, partner_user_id, referred_user_id,
  gross_amount_thb, net_amount_thb, commission_rate, commission_amount_thb,
  commission_base_amount_thb, status, hold_until, created_at,
  EXTRACT(EPOCH FROM (hold_until - created_at))/86400.0 AS hold_days
FROM public.commission_events
WHERE referred_user_id = '<customer-x-uuid>'
ORDER BY created_at DESC LIMIT 1;
```
✓ ต้องเห็น:
- `status='holding'`
- `commission_amount_thb=300` (1000 × 0.30)
- `commission_base_amount_thb=1000` (locked)
- `hold_days` อยู่ระหว่าง 20.99-21.01 (21 วันตรงกับ business commitment)

### Step 4.2 — Verify referral locked

```sql
SELECT attribution_status, commission_base_amount_thb, commission_rate, first_paid_at
FROM public.referrals
WHERE referred_user_id = '<customer-x-uuid>';
```
✓ `attribution_status='confirmed'`, base/rate ถูก lock, `first_paid_at` ตอนนี้

### Step 4.3 — Verify Partner A lifetime commission

```sql
SELECT lifetime_commission_thb, lifetime_paid_thb
FROM public.partners
WHERE user_id = '<partner-a-uuid>';
```
✓ `lifetime_commission_thb=300`, `lifetime_paid_thb=0` (ยังไม่จ่าย payout)

---

## §5 Self-referral fraud guard

### Step 5.1 — Partner B ใช้ ref ตัวเองสมัคร

- [ ] **ทำ**: Partner B logout → เปิด `https://workspace.mediaforge.co/app/pricing?ref=MF-BEE-CUSTOM` → พยายาม signup ด้วย email เดียวกัน (จะถูก redirect เพราะ existing user) → ลอง trigger flow โดย admin ใส่ referrals row ตรง:

**Setup SQL**:
```sql
INSERT INTO public.referrals (referrer_user_id, referred_user_id, code_id, code_type, attribution_status)
VALUES (
  '<partner-b-uuid>', '<partner-b-uuid>',
  (SELECT id FROM public.referral_codes WHERE code='MF-BEE-CUSTOM'),
  'partner_affiliate', 'confirmed'
);
```

- [ ] **ทำ**: trigger fake purchase สำหรับ Partner B ผ่าน Stripe test
- [ ] **คาดหวัง**: 
  - `accrue_commission` ไม่สร้าง commission_events row
  - `fraud_flags` ได้ row ใหม่ `kind='self_referral'`

**Verify SQL**:
```sql
SELECT count(*) FROM public.commission_events WHERE referred_user_id='<partner-b-uuid>';
-- คาดหวัง: 0

SELECT id, kind, severity, related_user_id, evidence
FROM public.fraud_flags
WHERE related_user_id = '<partner-b-uuid>' AND kind = 'self_referral';
-- คาดหวัง: 1 row
```

---

## §6 Hold window expiry + release_commission

### Step 6.1 — Fast-forward hold window (admin test workaround)

- [ ] **ทำ**: ใน SQL Editor:
```sql
UPDATE public.commission_events
SET hold_until = now() - interval '1 hour'
WHERE referred_user_id = '<customer-x-uuid>' AND status='holding';
```
- [ ] **ทำ**: Trigger release_commission:
```sql
SELECT public.release_commission();
```
- [ ] **คาดหวัง**: return >= 1 (จำนวน events ที่ release)

### Step 6.2 — Verify state transition

```sql
SELECT status, available_at FROM public.commission_events
WHERE referred_user_id='<customer-x-uuid>';
```
✓ `status='available'`, `available_at` set

### Step 6.3 — Verify wallet credit + ledger

```sql
SELECT user_id, balance_thb, lifetime_earned, updated_at
FROM public.cash_wallets
WHERE user_id='<partner-a-uuid>';
-- คาดหวัง: balance_thb=300, lifetime_earned=300

SELECT amount_thb, tx_type, reference_id, note
FROM public.cash_wallet_transactions
WHERE user_id='<partner-a-uuid>' AND tx_type='commission_released';
-- คาดหวัง: 1 row, amount_thb=300
```

---

## §7 Renewal accrual + PI→invoice resolution

### Step 7.1 — Trigger renewal payment

- [ ] **ทำ**: ใน Stripe Dashboard → Customers → Customer X subscription → "Pay invoice manually" หรือรอ Stripe trigger `invoice.paid` event
- [ ] **คาดหวัง**: commission_events ใหม่อีก 1 row (renewal) ด้วย `stripe_invoice_id` populated (ไม่ใช่ PI)

**Verify SQL**:
```sql
SELECT id, stripe_invoice_id, stripe_payment_intent_id, cycle_index, status, hold_until
FROM public.commission_events
WHERE referred_user_id='<customer-x-uuid>'
ORDER BY created_at;
```
✓ 2 rows:
- Row 1: `stripe_payment_intent_id LIKE 'pi_%'`, `stripe_invoice_id IS NULL`, `cycle_index=1`
- Row 2: `stripe_invoice_id LIKE 'in_%'`, `stripe_payment_intent_id IS NULL`, `cycle_index=2`

### Step 7.2 — Verify payment_transactions link

```sql
SELECT stripe_payment_intent_id, stripe_invoice_id, status
FROM public.payment_transactions
WHERE user_id='<customer-x-uuid>'
ORDER BY created_at DESC LIMIT 1;
```
✓ Row นี้จะถูกใช้ตอน refund webhook lookup PI → invoice

---

## §8 Payout request (partner-initiated)

### Step 8.1 — Happy path

- [ ] **ทำ**: Partner A → workspace → Affiliate dashboard → กด "Request payout 500 THB" (ต้องมี wallet balance >= 500)
- [ ] **คาดหวัง**: payout_requests row ใหม่ + UI แสดง "Pending review"

**Verify SQL**:
```sql
SELECT id, amount_thb, status, commission_ids, bank_snapshot
FROM public.payout_requests
WHERE partner_user_id='<partner-a-uuid>'
ORDER BY requested_at DESC LIMIT 1;
```
✓ `status='pending'`, `amount_thb=500`, `commission_ids` มี id ของ commissions ที่ถูกเลือก (FIFO เก่าสุดก่อน)

### Step 8.2 — Bank guard test

**Setup**: temporarily clear bank info
```sql
UPDATE public.partner_applications
SET bank_name='', bank_account_no=''
WHERE user_id='<partner-a-uuid>';
```

- [ ] **ทำ**: Partner A → กด Request payout
- [ ] **คาดหวัง**: error "bank_details_incomplete" หรือ message "Bank info missing"

**Restore**:
```sql
UPDATE public.partner_applications
SET bank_name='SCB', bank_account_no='0123456789'
WHERE user_id='<partner-a-uuid>';
```

### Step 8.3 — 'Pending' placeholder rejected

**Setup**:
```sql
UPDATE public.partner_applications
SET bank_name='Pending', bank_account_no='Pending'
WHERE user_id='<partner-a-uuid>';
```

- [ ] **ทำ**: Request payout
- [ ] **คาดหวัง**: error "bank_details_incomplete"

**Restore**: เหมือนข้างบน

### Step 8.4 — Minimum 500 THB

- [ ] **ทำ**: ลอง request payout 100 THB
- [ ] **คาดหวัง**: error "below_minimum_threshold: 500 THB"

### Step 8.5 — Insufficient balance

- [ ] **ทำ**: ลอง request payout จำนวนเงินมากกว่า wallet balance (เช่น 100000 THB)
- [ ] **คาดหวัง**: error "insufficient_balance: available=X, requested=Y"

---

## §9 Admin processes payout (ERP)

### Step 9.1 — Admin marks processing

- [ ] **ทำ**: เข้า ERP → Affiliate → Payouts → เปิด pending payout ของ Partner A → กด "Mark processing"
- [ ] **คาดหวัง**: `status='processing'`

### Step 9.2 — Admin transfers money externally + marks paid

- [ ] **ทำ**: ทำการโอนเงินจริง (ในกรณี test ไม่ต้องโอน — สมมติว่าโอนแล้ว) → กลับมา ERP → กด "Mark paid" + ใส่ bank reference "TEST-REF-001"
- [ ] **คาดหวัง**: payout flipped to paid + ทุก commissions ใน array flip to paid + lifetime_paid_thb เพิ่ม + wallet debit + ledger row

**Verify SQL**:
```sql
-- Payout state
SELECT status, processed_at, proof_url FROM public.payout_requests WHERE id='<payout-id>';
-- ✓ status='paid'

-- Commissions flipped
SELECT id, status, paid_at, payout_id FROM public.commission_events
WHERE id = ANY((SELECT commission_ids FROM public.payout_requests WHERE id='<payout-id>'));
-- ✓ ทุก row status='paid', payout_id=<payout-id>

-- Wallet debited
SELECT balance_thb FROM public.cash_wallets WHERE user_id='<partner-a-uuid>';
-- ✓ balance_thb ลดเท่า amount

-- Ledger row
SELECT amount_thb, tx_type, reference_id FROM public.cash_wallet_transactions
WHERE user_id='<partner-a-uuid>' AND tx_type='payout_debit' AND reference_id='<payout-id>';
-- ✓ 1 row, amount_thb เป็นลบ

-- Partner lifetime
SELECT lifetime_paid_thb FROM public.partners WHERE user_id='<partner-a-uuid>';
-- ✓ เพิ่มเท่า amount
```

### Step 9.3 — Cannot re-pay paid payout

- [ ] **ทำ**: กด "Mark paid" บน payout ที่ paid แล้ว
- [ ] **คาดหวัง**: error 409 "Already paid"

---

## §10 Refund scenarios — ครอบทุก state

### Step 10.1 — Refund commission ที่ยังอยู่ใน `holding`

**Setup**: ทำ customer ใหม่ + commission ใหม่
- [ ] Customer X2 ซื้อด้วย ref Partner A → commission_events ใหม่ status=holding

- [ ] **ทำ**: Stripe Dashboard → ค้น payment ของ Customer X2 → กด "Refund"
- [ ] **คาดหวัง**: webhook `charge.refunded` → reverse_commission RPC ทำงาน → commission flipped to `clawback`

**Verify SQL** (รอ 5-10 วินาทีหลัง refund):
```sql
SELECT status, reversed_at, reversal_reason, reversed_by_refund_id
FROM public.commission_events
WHERE referred_user_id='<customer-x2-uuid>';
-- ✓ status='clawback', reversed_by_refund_id เริ่มด้วย 're_'
```

**Verify wallet not touched** (commission ยัง holding ตอน refund):
```sql
SELECT count(*) FROM public.cash_wallet_transactions
WHERE user_id='<partner-a-uuid>' AND tx_type='commission_refunded'
  AND reference_id IN (SELECT id::text FROM public.commission_events WHERE referred_user_id='<customer-x2-uuid>');
-- ✓ 0 (holding ไม่แตะ wallet)
```

### Step 10.2 — Refund commission ที่ `available` (ใน wallet)

**Setup**: ทำ Customer X3 → จ่ายเงิน → fast-forward hold → release → commission อยู่ wallet
```sql
-- หลัง Customer X3 จ่าย
UPDATE public.commission_events SET hold_until = now() - interval '1 hour'
WHERE referred_user_id='<customer-x3-uuid>' AND status='holding';
SELECT public.release_commission();
```

- [ ] **ทำ**: Stripe refund Customer X3's payment
- [ ] **คาดหวัง**: commission → clawback + **wallet ถูก debit** + ledger row `commission_refunded`

**Verify SQL**:
```sql
SELECT balance_thb FROM public.cash_wallets WHERE user_id='<partner-a-uuid>';
-- ✓ ลดเท่า 300

SELECT amount_thb, tx_type FROM public.cash_wallet_transactions
WHERE user_id='<partner-a-uuid>' AND tx_type='commission_refunded'
ORDER BY created_at DESC LIMIT 1;
-- ✓ amount=-300, tx_type='commission_refunded'
```

### Step 10.3 — ⭐ Refund ระหว่าง payout pending (Hole 1 fix)

**Setup**: 
1. Customer X4 จ่าย → commission holding → fast-forward + release → available
2. Partner A request_payout → pending status

- [ ] **ทำ**: Stripe refund Customer X4 (commission อยู่ใน pending payout)
- [ ] **คาดหวัง**: 
  - commission → clawback
  - **payout → cancelled** (NEW behavior from PR #50)
  - audit log row `payout_cancelled_on_refund`

**Verify SQL**:
```sql
-- Payout cancelled
SELECT status, cancelled_at, cancellation_reason
FROM public.payout_requests
WHERE id='<payout-with-x4-commission>';
-- ✓ status='cancelled', cancellation_reason starts with 'commission_refunded:'

-- Audit row
SELECT action, diff
FROM public.affiliate_audit_log
WHERE action='payout_cancelled_on_refund'
  AND entity_id='<payout-id>';
-- ✓ 1 row, diff contains refund_id + clawbacked_commission_ids
```

### Step 10.4 — Admin cannot pay cancelled payout

- [ ] **ทำ**: ERP → ลอง mark_payout_paid บน payout ที่ cancelled
- [ ] **คาดหวัง**: error 409 "Cannot pay a cancelled payout"

### Step 10.5 — ⭐ Hole 2 — refund หลัง payout paid

- [ ] **ทำ**: Stripe refund Customer X (จาก §4 ที่จ่าย commission และ payout จ่ายไปแล้ว)
- [ ] **คาดหวัง**: 
  - commission **status='paid' ยังเหมือนเดิม** (ไม่ flip เป็น clawback)
  - payout **status='paid' ยังเหมือนเดิม**
  - partner เก็บเงินไว้ — MediaForge absorbs loss

**Verify SQL**:
```sql
SELECT status FROM public.commission_events WHERE referred_user_id='<customer-x-uuid>';
-- ✓ ยังเป็น 'paid' (ทุก row)

SELECT status FROM public.payout_requests WHERE id='<old-payout-id>';
-- ✓ ยังเป็น 'paid'
```

---

## §11 Dispute path (chargeback)

### Step 11.1 — Trigger dispute via Stripe test

- [ ] **ทำ**: Stripe Dashboard → หา payment ของ Customer ที่ commission ยัง holding → กด "..." → Create test dispute → reason: "fraudulent"
- [ ] **คาดหวัง**: webhook `charge.dispute.created` fire → handleDisputeCreated → reverse_commission ด้วย dispute.id

**Verify SQL**:
```sql
SELECT status, reversed_by_refund_id, reversal_reason
FROM public.commission_events
WHERE stripe_payment_intent_id='<disputed-PI>';
-- ✓ status='clawback', reversed_by_refund_id starts with 'dp_' (dispute id)
-- ✓ reversal_reason starts with 'stripe_dispute:'
```

### Step 11.2 — Dispute webhook re-delivery (idempotency)

- [ ] **ทำ**: Stripe Dashboard → Webhooks → ใน event log หา dispute.created event → กด "Resend"
- [ ] **คาดหวัง**: ไม่มี state เปลี่ยน, ไม่มี audit row เพิ่ม

**Verify SQL**:
```sql
-- Audit count ก่อนและหลัง resend ต้องเท่าเดิม
SELECT count(*) FROM public.affiliate_audit_log
WHERE entity_id='<commission-event-id>';
```

### Step 11.3 — Dispute resolved in our favor (manual restore)

- [ ] **ทำ**: Stripe Dashboard → close dispute as "won" → ตอนนี้ commission ใน DB ยังเป็น clawback (intentional — restore is manual)
- [ ] **ทำ**: Admin จะต้อง manual restore ผ่าน SQL หรือ ERP action (มีอยู่หรือต้อง add ภายหลัง)

```sql
-- Manual restore SQL
UPDATE public.commission_events
   SET status='holding', reversed_at=NULL, reversal_reason=NULL, reversed_by_refund_id=NULL
 WHERE id='<commission-id>';
UPDATE public.partners
   SET lifetime_commission_thb = lifetime_commission_thb + <amount>
 WHERE user_id='<partner-id>';
```

---

## §12 Suspend / unsuspend partner

### Step 12.1 — Suspend Partner B

- [ ] **ทำ**: ERP → เปิด Partner B detail → กด "Suspend" + reason "Quality issue"
- [ ] **คาดหวัง**:
  - `partners.suspended_at` set
  - `partners.suspended_reason` set
  - ทุก code ของ Partner B → `is_active=false`

**Verify SQL**:
```sql
SELECT p.suspended_at, p.suspended_reason,
       array_agg(rc.is_active) AS codes_active
FROM public.partners p
LEFT JOIN public.referral_codes rc ON rc.user_id=p.user_id
WHERE p.user_id='<partner-b-uuid>'
GROUP BY p.suspended_at, p.suspended_reason;
-- ✓ suspended_at set, all codes inactive
```

### Step 12.2 — Suspended partner ไม่ accrue commission

- [ ] **ทำ**: Customer Z สมัครผ่าน Partner B's code (ที่ inactive ตอนนี้) → จ่ายเงิน
- [ ] **คาดหวัง**: ไม่มี commission_events ใหม่สำหรับ Partner B

```sql
SELECT count(*) FROM public.commission_events WHERE partner_user_id='<partner-b-uuid>'
  AND created_at > '<test-start-time>';
-- ✓ 0
```

### Step 12.3 — Unsuspend

- [ ] **ทำ**: ERP → กด "Unsuspend" บน Partner B
- [ ] **คาดหวัง**: `suspended_at=NULL`, all codes `is_active=true`

---

## §13 Adjust commission rate / tier override

### Step 13.1 — เปลี่ยน rate ของ Partner A

- [ ] **ทำ**: ERP → Partner A → Adjust commission rate to 0.40
- [ ] **คาดหวัง**: `partners.commission_rate=0.40`

**Verify**: 
```sql
SELECT commission_rate FROM public.partners WHERE user_id='<partner-a-uuid>';
```

### Step 13.2 — Old referrals ยังใช้ rate เดิม (locked)

- [ ] **ทำ**: Customer X (referral เก่า) จ่ายเงินรอบที่ 3
- [ ] **คาดหวัง**: commission_events ใหม่ใช้ rate **0.30** (rate ที่ lock ตอน first paid) ไม่ใช่ 0.40

**Verify**:
```sql
SELECT commission_rate, commission_amount_thb FROM public.commission_events
WHERE referred_user_id='<customer-x-uuid>'
ORDER BY created_at DESC LIMIT 1;
-- ✓ commission_rate=0.30, amount=300 (ไม่ใช่ 400)
```

### Step 13.3 — Tier override

- [ ] **ทำ**: ERP → Partner A → set_tier_override "creator_20"
- [ ] **คาดหวัง**: `partners.tier='creator_20'`

```sql
SELECT tier FROM public.partners WHERE user_id='<partner-a-uuid>';
```

---

## §14 Reconciliation cron (8 invariants)

### Step 14.1 — Trigger reconcile manually

- [ ] **ทำ**: SQL Editor →
```sql
SELECT public.affiliate_reconcile();
```
- [ ] **คาดหวัง**: return integer = จำนวน drift detected

### Step 14.2 — Verify no drift on healthy state

ถ้าระบบทำงานปกติ:
```sql
SELECT count(*) FROM public.affiliate_audit_log
WHERE action='reconciliation_drift'
  AND created_at > now() - interval '1 minute';
-- ✓ ผลควรเป็น 0 (ถ้าไม่มี admin write ผิดปกติ)
```

### Step 14.3 — Inject drift + verify detection

**Setup**: สร้าง drift artificially
```sql
-- Simulate Hole 2 admin write (paid event clawback)
UPDATE public.commission_events
SET status='clawback', reversed_at=now(), reversal_reason='manual_test'
WHERE id='<one-of-paid-event-ids>';
-- ลด lifetime ตาม
UPDATE public.partners SET lifetime_commission_thb=lifetime_commission_thb-300
WHERE user_id='<partner-a-uuid>';
```

- [ ] **ทำ**: `SELECT public.affiliate_reconcile();`
- [ ] **คาดหวัง**: return >= 1, audit log มี Drift B row

```sql
SELECT diff->>'invariant', diff
FROM public.affiliate_audit_log
WHERE action='reconciliation_drift'
  AND entity_id='<partner-a-uuid>'
ORDER BY created_at DESC LIMIT 1;
-- ✓ invariant='B_paid_commissions_vs_paid_payouts'
```

### Step 14.4 — Dedup index test

- [ ] **ทำ**: run reconcile ซ้ำ (`SELECT public.affiliate_reconcile();`)
- [ ] **คาดหวัง**: audit log row ของ Drift B ยังเป็น 1 row (ไม่ duplicate)

---

## §15 Drift email notifier

### Step 15.1 — Trigger notifier

- [ ] **ทำ**: 
```bash
curl -X POST https://fymncypboeubdikpbmqc.supabase.co/functions/v1/affiliate-drift-notifier \
  -H "Authorization: Bearer <CRON_SECRET>" \
  -H "Content-Type: application/json"
```
- [ ] **คาดหวัง**: 200 OK, email ถูกส่ง (ถ้ามี drift ใน audit log)

### Step 15.2 — Verify email received

- [ ] **ทำ**: เช็ค inbox ของ admin email (ที่ set ใน `AFFILIATE_DRIFT_NOTIFICATION_EMAIL`)
- [ ] **คาดหวัง**: email subject มี "Affiliate drift detected" + N rows

### Step 15.3 — Auth test

- [ ] **ทำ**: ลอง call โดยไม่มี Authorization header
- [ ] **คาดหวัง**: 401

- [ ] **ทำ**: ลอง call ด้วย token ผิด
- [ ] **คาดหวัง**: 401

---

## §16 RLS security tests

### Step 16.1 — Self-promote application blocked

- [ ] **ทำ**: Login as Partner C ที่มี application status='draft' → run SQL ผ่าน supabase-js:
```javascript
await supabase.from('partner_applications')
  .update({ status: 'approved' })
  .eq('id', '<own-app-id>');
```
- [ ] **คาดหวัง**: error / no rows updated

**Verify**:
```sql
SELECT status FROM public.partner_applications WHERE id='<app-id>';
-- ✓ ยังเป็น 'draft'
```

### Step 16.2 — Cross-user data leak test

- [ ] **ทำ**: Login as Partner A → ลอง query `public.commission_events` ของ Partner B
- [ ] **คาดหวัง**: ไม่เห็น row ของคนอื่น (RLS filter)

---

## §17 Final reconciliation + cleanup

### Step 17.1 — Total state check

```sql
WITH summary AS (
  SELECT
    (SELECT count(*) FROM public.partner_applications WHERE status='approved') AS approved_apps,
    (SELECT count(*) FROM public.partners WHERE suspended_at IS NULL) AS active_partners,
    (SELECT count(*) FROM public.commission_events WHERE status='holding') AS holding,
    (SELECT count(*) FROM public.commission_events WHERE status='available') AS available,
    (SELECT count(*) FROM public.commission_events WHERE status='paid') AS paid,
    (SELECT count(*) FROM public.commission_events WHERE status='clawback') AS clawback,
    (SELECT count(*) FROM public.payout_requests WHERE status='pending') AS pending_payouts,
    (SELECT count(*) FROM public.payout_requests WHERE status='paid') AS paid_payouts,
    (SELECT count(*) FROM public.payout_requests WHERE status='cancelled') AS cancelled_payouts,
    (SELECT count(*) FROM public.affiliate_audit_log
      WHERE created_at > now() - interval '24 hours') AS audit_24h
)
SELECT * FROM summary;
```
- [ ] เปรียบกับ baseline ที่จดไว้ตอนเริ่ม — ตัวเลขเปลี่ยนตามที่คาด

### Step 17.2 — Verify business invariants

```sql
-- Per partner: sum of paid commission_amount = sum of paid payout amount
SELECT
  p.user_id,
  COALESCE((SELECT sum(commission_amount_thb) FROM public.commission_events ce
            WHERE ce.partner_user_id=p.user_id AND ce.status='paid'), 0) AS paid_commissions,
  COALESCE((SELECT sum(amount_thb) FROM public.payout_requests pr
            WHERE pr.partner_user_id=p.user_id AND pr.status='paid'), 0) AS paid_payouts,
  p.lifetime_paid_thb
FROM public.partners p
WHERE p.user_id IN ('<partner-a-uuid>','<partner-b-uuid>');
```
- [ ] **คาดหวัง**: `paid_commissions = paid_payouts = lifetime_paid_thb` สำหรับทุก partner (ยกเว้น Hole 2 cases ที่ admin manual clawback)

---

## ✅ Final checklist

ทุก section ต้อง verify:
- [ ] §1 self-serve onboarding
- [ ] §2 manual ERP onboarding
- [ ] §3 first-touch attribution
- [ ] §4 commission accrual + 21-day hold
- [ ] §5 self-referral fraud guard
- [ ] §6 release_commission + wallet credit
- [ ] §7 renewal accrual (separate row)
- [ ] §8 payout request + guards (bank/min/insufficient)
- [ ] §9 admin process payout (atomic flips)
- [ ] §10 refund all 4 states (holding/available/pending payout/paid)
- [ ] §11 dispute path + idempotency
- [ ] §12 suspend/unsuspend
- [ ] §13 commission rate adjust + lock semantics
- [ ] §14 reconciliation cron + drift detection
- [ ] §15 drift email notifier
- [ ] §16 RLS security
- [ ] §17 final state reconciliation

---

## 🐛 ถ้าเจอ bug

1. **เก็บ evidence**:
   - Screenshot UI ที่เห็น error
   - SQL query result ที่ผิดปกติ
   - Stripe Dashboard webhook log timestamp
2. **Copy state**:
   ```sql
   SELECT * FROM public.affiliate_audit_log
   WHERE created_at > '<test-start-time>'
   ORDER BY created_at DESC;
   ```
3. **Report** ตาม section ที่ fail
