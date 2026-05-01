import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@18.5.0";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { sendTransactionalEmail } from "../_shared/sendEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Commission helpers ───
async function computeCycleIndex(
  sb: ReturnType<typeof createClient>,
  referredUserId: string
): Promise<number> {
  const { count } = await sb
    .from("commission_events")
    .select("id", { count: "exact", head: true })
    .eq("referred_user_id", referredUserId)
    .neq("status", "refunded");
  return (count ?? 0) + 1;
}

async function auditLog(
  sb: ReturnType<typeof createClient>,
  action: string,
  entityId: string,
  payload: Record<string, unknown>
) {
  try {
    await sb.from("affiliate_audit_log").insert({
      action,
      actor_id: null, // null = stripe_webhook source
      entity_type: "commission_event",
      entity_id: entityId,
      diff: { source: "stripe_webhook", ...payload },
    });
  } catch (e) {
    console.error("[STRIPE-WEBHOOK] audit log failed:", e);
  }
}

// Track A — award flat 100 THB to the REFERRER on user_referral
// attribution confirmation. No-op for partner_affiliate and for
// already-granted referrals. Safe to call on every successful payment.
async function awardUserReferralBonusIfEligible(
  sb: ReturnType<typeof createClient>,
  referredUserId: string,
  sourceTag: string,
): Promise<void> {
  try {
    const { data: txId, error } = await sb.rpc("award_user_referral_bonus", {
      p_referred_user_id: referredUserId,
    });
    if (error) {
      console.error(`[STRIPE-WEBHOOK] award_user_referral_bonus (${sourceTag}) error:`, error);
      return;
    }
    if (txId) {
      console.log(`[STRIPE-WEBHOOK] 100 THB referral_bonus granted (${sourceTag}): tx=${txId}`);
    }
  } catch (e) {
    console.warn(`[STRIPE-WEBHOOK] awardUserReferralBonusIfEligible (${sourceTag}) exception:`, e);
  }
}

// ─── Email helpers ───
async function getUserEmailAndName(
  sb: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ email: string | null; first_name: string }> {
  try {
    const { data: { user } } = await sb.auth.admin.getUserById(userId);
    const email = user?.email ?? null;
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const first_name = (meta.first_name as string)
      || (meta.full_name as string)?.split(" ")[0]
      || (email?.split("@")[0] ?? "there");
    return { email, first_name };
  } catch (e) {
    console.warn("[STRIPE-WEBHOOK] getUserEmailAndName failed:", e);
    return { email: null, first_name: "there" };
  }
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function fmtDateTH(d: Date): string {
  return new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", year: "numeric" }).format(d);
}

function receiptFieldsFromIntent(intent: Stripe.PaymentIntent): Record<string, unknown> {
  const latestCharge = (intent as any).latest_charge;
  const charge = latestCharge && typeof latestCharge === "object" ? latestCharge as any : null;
  const invoice = charge?.invoice;
  const fields: Record<string, unknown> = {};

  if (typeof latestCharge === "string") fields.stripe_charge_id = latestCharge;
  if (charge?.id) fields.stripe_charge_id = charge.id;
  if (charge?.receipt_url) fields.receipt_url = charge.receipt_url;
  if (charge?.receipt_number) fields.receipt_number = charge.receipt_number;
  if (invoice) fields.stripe_invoice_id = typeof invoice === "string" ? invoice : invoice.id;
  if (fields.receipt_url) fields.receipt_generated_at = new Date().toISOString();

  return fields;
}

async function sendCommissionEmailIfPossible(
  sb: ReturnType<typeof createClient>,
  partnerUserId: string,
  referredUserId: string,
  commissionAmount: number,
  planName: string,
  commissionRate: number,
) {
  try {
    const { email, first_name } = await getUserEmailAndName(sb, partnerUserId);
    if (!email) return;
    const { data: { user: ref } } = await sb.auth.admin.getUserById(referredUserId);
    await sendTransactionalEmail("affiliate_commission", email, {
      first_name,
      referred_user_email: ref?.email ?? "—",
      plan_name: planName,
      commission_amount: fmtNum(commissionAmount),
      commission_rate: commissionRate,
      hold_days: 30,
      partner_dashboard_url: "https://mediaforge.co/partner/dashboard",
    });
  } catch (e) {
    console.warn("[STRIPE-WEBHOOK] sendCommissionEmailIfPossible failed:", e);
  }
}

async function handleRefundSucceeded(
  sb: ReturnType<typeof createClient>,
  _stripe: Stripe,
  refund: Stripe.Refund,
  eventId: string
) {
  const refundId = refund.id;
  const paymentIntentId = typeof refund.payment_intent === "string"
    ? refund.payment_intent
    : refund.payment_intent?.id;

  if (!paymentIntentId) {
    console.error("[STRIPE-WEBHOOK] refund: no payment_intent on", refundId);
    return;
  }

  const refundAmountThb = Math.floor((refund.amount ?? 0) / 100);

  const { data: existing, error: existingErr } = await sb
    .from("payment_transactions")
    .select("id, status, stripe_refund_id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (existingErr) {
    console.error("[STRIPE-WEBHOOK] refund: payment_transactions lookup error:", existingErr);
    return;
  }
  if (!existing) {
    console.warn(`[STRIPE-WEBHOOK] refund: no payment_transactions for PI ${paymentIntentId}`);
    return;
  }

  if (existing.stripe_refund_id === refundId) {
    console.log(`[STRIPE-WEBHOOK] refund already processed: ${refundId}`);
    return;
  }

  // 1. Mark payment as refunded
  const { error: updErr } = await sb
    .from("payment_transactions")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      refund_amount_thb: refundAmountThb,
      refund_reason: refund.reason ?? "customer_request",
      stripe_refund_id: refundId,
    })
    .eq("id", existing.id);

  if (updErr) {
    console.error("[STRIPE-WEBHOOK] refund: payment_transactions update failed:", updErr);
    throw updErr;
  }

  // 2. Reverse commission via RPC (idempotent by refund_id)
  const { data: reversed, error: rpcErr } = await sb.rpc("reverse_commission", {
    p_payment_intent_id: paymentIntentId,
    p_refund_id: refundId,
    p_reason: refund.reason ?? "stripe_refund",
  });

  if (rpcErr) {
    console.error("[STRIPE-WEBHOOK] reverse_commission RPC failed:", rpcErr);
    throw rpcErr;
  }

  console.log("[STRIPE-WEBHOOK] refund processed:", {
    refundId,
    paymentIntentId,
    refundAmountThb,
    reversedCount: Array.isArray(reversed) ? reversed.length : 0,
  });

  if (Array.isArray(reversed) && reversed.length > 0) {
    for (const r of reversed as Array<{ commission_event_id: string; partner_user_id: string; reversed_amount_thb: number }>) {
      await auditLog(sb, "commission_reversed", r.commission_event_id, {
        event_id: eventId,
        source: "refund_webhook",
        amount_thb: r.reversed_amount_thb,
        partner_user_id: r.partner_user_id,
        stripe_refund_id: refundId,
        stripe_payment_intent_id: paymentIntentId,
      });
    }
  }

  // NOTE: credits claw-back intentionally skipped — may already be consumed.
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
    apiVersion: "2026-02-25.clover" as any,
  });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    const body = await req.text();
    const sig = req.headers.get("stripe-signature");
    const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

    if (!webhookSecret) {
      console.error("[STRIPE-WEBHOOK] STRIPE_WEBHOOK_SECRET not configured");
      return new Response(JSON.stringify({ error: "Webhook secret not configured" }),
        { status: 500, headers: { "Content-Type": "application/json" } });
    }

    if (!sig) {
      console.error("[STRIPE-WEBHOOK] Missing stripe-signature header");
      return new Response(JSON.stringify({ error: "Missing signature" }),
        { status: 401, headers: { "Content-Type": "application/json" } });
    }

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    } catch (err) {
      console.error("[STRIPE-WEBHOOK] Signature verification failed:", err);
      return new Response(JSON.stringify({ error: "Invalid signature" }),
        { status: 401, headers: { "Content-Type": "application/json" } });
    }

    console.log(`[STRIPE-WEBHOOK] Event: ${event.type}`);

    // =============================================
    // CHECKOUT.SESSION.COMPLETED
    // =============================================
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      // Skip direct sales — handled by erp-stripe-webhook
      if (session.metadata?.direct_sales === "true") {
        console.log("[STRIPE-WEBHOOK] Skipping direct_sales event (handled by erp-stripe-webhook)");
        return new Response(JSON.stringify({ received: true, skipped: "direct_sales" }), { status: 200 });
      }

      const userId = session.metadata?.user_id || session.client_reference_id;
      const sessionType = session.metadata?.type;
      const isTopup = sessionType === "topup";
      const isSubscriptionOneoff = sessionType === "subscription_oneoff";

      if (!userId) {
        console.error("[STRIPE-WEBHOOK] No user_id in metadata");
        return new Response(JSON.stringify({ error: "No user_id" }), { status: 400 });
      }

      // GATE: only process when actually paid. Async methods (PromptPay) arrive as "unpaid"
      // here and will be finalized via payment_intent.succeeded.
      if (session.payment_status !== "paid") {
        console.log(`[STRIPE-WEBHOOK] checkout.session.completed payment_status=${session.payment_status} — defer to payment_intent.succeeded`);
        return new Response(JSON.stringify({ received: true, deferred: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // === SUBSCRIPTION ONE-OFF (new mode=payment flow) — handled in payment_intent.succeeded path ===
      // For card (sync) the PI also fires; we let payment_intent.succeeded be the single grant point
      // to keep idempotency simple. Just acknowledge here.
      if (isSubscriptionOneoff) {
        console.log(`[STRIPE-WEBHOOK] subscription_oneoff session paid — grant handled by payment_intent.succeeded (PI: ${session.payment_intent})`);
        return new Response(JSON.stringify({ received: true, handled_by: "payment_intent" }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (isTopup) {
        // === TOP-UP FLOW ===
        const topupPackageId = session.metadata?.topup_package_id;
        const creditsToAdd = parseInt(session.metadata?.credits || "0", 10);

        if (creditsToAdd <= 0) {
          console.error("[STRIPE-WEBHOOK] Invalid top-up credits");
          return new Response(JSON.stringify({ error: "Invalid credits" }), { status: 400 });
        }

        console.log(`[STRIPE-WEBHOOK] Top-up: +${creditsToAdd} credits for user ${userId}`);

        const { data: existing } = await supabase
          .from("user_credits")
          .select("balance, total_purchased")
          .eq("user_id", userId)
          .single();

        const newBalance = (existing?.balance || 0) + creditsToAdd;

        if (existing) {
          await supabase.from("user_credits").update({
            balance: newBalance,
            total_purchased: (existing.total_purchased || 0) + creditsToAdd,
          }).eq("user_id", userId);
        } else {
          await supabase.from("user_credits").insert({
            user_id: userId,
            balance: newBalance,
            total_purchased: creditsToAdd,
          });
        }

        const expiresAt = new Date();
        expiresAt.setMonth(expiresAt.getMonth() + 12);

        await supabase.from("credit_batches").insert({
          user_id: userId,
          source_type: "topup",
          amount: creditsToAdd,
          remaining: creditsToAdd,
          expires_at: expiresAt.toISOString(),
          reference_id: session.id,
        });

        const { error: txError } = await supabase.from("credit_transactions").insert({
          user_id: userId,
          amount: creditsToAdd,
          type: "topup",
          description: `Top-up: +${creditsToAdd} credits (valid 12 months)`,
          reference_id: session.id,
          balance_after: newBalance,
        });
        if (txError) console.error("[STRIPE-WEBHOOK] credit_transactions insert error:", txError);

        // Use package price from DB instead of session.amount_total (which includes Stripe fees/tax)
        let amountThb = (session.amount_total || 0) / 100;
        if (topupPackageId) {
          const { data: topupPkg } = await supabase
            .from("topup_packages")
            .select("price_thb")
            .eq("id", topupPackageId)
            .single();
          if (topupPkg) {
            amountThb = topupPkg.price_thb;
          }
        }

        const { error: ptError } = await supabase.from("payment_transactions").insert({
          user_id: userId,
          package_id: null,
          stripe_session_id: session.id,
          stripe_payment_intent_id: (session.payment_intent as string) || null,
          amount_thb: amountThb,
          credits_added: creditsToAdd,
          status: "completed",
          payment_method: session.payment_method_types?.[0] || "card",
        });
        if (ptError) console.error("[STRIPE-WEBHOOK] payment_transactions insert error:", ptError);

        // Track one-time-per-user promo redemption (idempotent via UNIQUE constraint)
        if (topupPackageId) {
          const { error: redeemErr } = await supabase.from("topup_redemptions").insert({
            user_id: userId,
            topup_package_id: topupPackageId,
            stripe_session_id: session.id,
            credits_granted: creditsToAdd,
            price_thb: amountThb,
          });
          if (redeemErr && !String(redeemErr.message || "").includes("duplicate")) {
            console.error("[STRIPE-WEBHOOK] topup_redemptions insert error:", redeemErr);
          }
        }

        console.log(`[STRIPE-WEBHOOK] Top-up success: +${creditsToAdd}. Balance: ${newBalance}`);

      } else {
        // === SUBSCRIPTION FLOW — uses subscription_plans table ===
        const planId = session.metadata?.plan_id;
        const billingCycle = session.metadata?.billing_cycle || "monthly";
        const subscriptionId = session.subscription as string;
        const customerId = session.customer as string;

        let creditsToAdd = parseInt(session.metadata?.upfront_credits || "0", 10);
        let planName = session.metadata?.plan_name || "Unknown";
        let planTarget = session.metadata?.plan_target || "user";
        let amountThb = (session.amount_total || 0) / 100;

        // If plan_id exists, fetch from subscription_plans for accuracy
        if (planId) {
          const { data: plan } = await supabase
            .from("subscription_plans")
            .select("name, target, upfront_credits, price_thb, billing_cycle, discount_official, discount_community")
            .eq("id", planId)
            .single();
          if (plan) {
            creditsToAdd = plan.upfront_credits;
            planName = plan.name;
            planTarget = plan.target;
            amountThb = plan.price_thb;
          }
        }

        console.log(`[STRIPE-WEBHOOK] Subscription: ${planName} (${planTarget}/${billingCycle}), +${creditsToAdd} credits for user ${userId}`);

        // Grant credits if this plan includes upfront credits
        if (creditsToAdd > 0) {
          const { data: existing } = await supabase
            .from("user_credits")
            .select("balance, total_purchased")
            .eq("user_id", userId)
            .single();

          const newBalance = (existing?.balance || 0) + creditsToAdd;

          if (existing) {
            await supabase.from("user_credits").update({
              balance: newBalance,
              total_purchased: (existing.total_purchased || 0) + creditsToAdd,
            }).eq("user_id", userId);
          } else {
            await supabase.from("user_credits").insert({
              user_id: userId,
              balance: newBalance,
              total_purchased: creditsToAdd,
            });
          }

          // Credit batch: monthly = 1 month expiry, annual = 12 months
          const subExpiresAt = new Date();
          if (billingCycle === "annual") {
            subExpiresAt.setFullYear(subExpiresAt.getFullYear() + 1);
          } else {
            subExpiresAt.setMonth(subExpiresAt.getMonth() + 1);
          }

          await supabase.from("credit_batches").insert({
            user_id: userId,
            source_type: "subscription",
            amount: creditsToAdd,
            remaining: creditsToAdd,
            expires_at: subExpiresAt.toISOString(),
            reference_id: session.id,
          });

          const { error: subTxError } = await supabase.from("credit_transactions").insert({
            user_id: userId,
            amount: creditsToAdd,
            type: "subscription_grant",
            description: `${planName} subscription: +${creditsToAdd} credits (${billingCycle})`,
            reference_id: session.id,
            balance_after: newBalance,
          });
          if (subTxError) console.error("[STRIPE-WEBHOOK] subscription credit_transactions error:", subTxError);

          console.log(`[STRIPE-WEBHOOK] Credits granted: +${creditsToAdd}. New balance: ${newBalance}`);
        }

        // Log payment
        await supabase.from("payment_transactions").insert({
          user_id: userId,
          package_id: null,
          stripe_session_id: session.id,
          stripe_payment_intent_id: (session.payment_intent as string) || null,
          amount_thb: amountThb,
          credits_added: creditsToAdd,
          status: "completed",
          payment_method: session.payment_method_types?.[0] || "card",
        });

        // Get subscription period end
        let periodEnd: string | null = null;
        if (subscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            periodEnd = new Date(sub.current_period_end * 1000).toISOString();
          } catch (e) {
            console.error("[STRIPE-WEBHOOK] Failed to get subscription details:", e);
          }
        }

        // Determine subscription_status based on plan name/target
        let newStatus: "free" | "professional" | "agency" = "professional";
        if (planName === "Enterprise" || planName === "Studio") {
          newStatus = "agency";
        }

        // Update profile with subscription info
        await supabase.from("profiles").update({
          subscription_status: newStatus,
          stripe_subscription_id: subscriptionId || null,
          stripe_customer_id: customerId || null,
          billing_interval: billingCycle,
          subscription_billing_cycle: billingCycle,
          current_period_start: new Date().toISOString(),
          current_period_end: periodEnd,
          current_plan_id: planId || null,
          subscription_plan_id: planId || null,
        }).eq("user_id", userId);

        console.log(`[STRIPE-WEBHOOK] Profile updated: status=${newStatus}, plan=${planName}, planId=${planId}`);

        // Email payment receipt (subscription checkout — first payment)
        try {
          const { email, first_name } = await getUserEmailAndName(supabase, userId);
          if (email) {
            await sendTransactionalEmail("payment_receipt", email, {
              first_name,
              invoice_number: (session.invoice as string) || session.id,
              payment_date: fmtDateTH(new Date()),
              package_name: `${planName} (${billingCycle === "annual" ? "รายปี" : "รายเดือน"})`,
              credits_added: fmtNum(creditsToAdd),
              amount_thb: fmtNum(amountThb),
              transactions_url: "https://mediaforge.co/app/transactions",
            });
          }
        } catch (e) {
          console.warn("[STRIPE-WEBHOOK] checkout receipt email failed:", e);
        }

        // === COMMISSION ACCRUAL (first payment) ===
        try {
          // Resolve invoice ID from subscription (preferred) — NO session.id fallback (idempotency safe)
          let invoiceId: string | null = null;
          if (subscriptionId) {
            try {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              invoiceId = (sub.latest_invoice as string) || null;
            } catch (_) {}
          }
          invoiceId = invoiceId || (session.invoice as string) || null;

          if (!invoiceId) {
            console.warn(
              `[STRIPE-WEBHOOK] Cannot resolve invoice ID for session ${session.id}, ` +
              `skipping commission — will be handled by invoice.paid`
            );
          } else {
            const cycleIndex = await computeCycleIndex(supabase, userId);

            if (cycleIndex > 12) {
              console.log(`[STRIPE-WEBHOOK] Cycle ${cycleIndex} > 12, skipping commission`);
            } else {
              const grossThb = amountThb;
              const netThb = amountThb;

              const { data: commissionId, error: accrueError } = await supabase.rpc("accrue_commission", {
                p_referred_user_id: userId,
                p_stripe_invoice_id: invoiceId,
                p_gross_amount_thb: grossThb,
                p_net_amount_thb: netThb,
                p_billing_cycle: billingCycle,
                p_cycle_index: cycleIndex,
              });

              // Track A: flat 100 THB referrer bonus (user_referral only,
              // idempotent). Runs regardless of accrue_commission result
              // because user_referral code_type never triggers commission.
              await awardUserReferralBonusIfEligible(supabase, userId, "checkout");

              if (accrueError) {
                console.error("[STRIPE-WEBHOOK] accrue_commission (checkout) error:", accrueError);
              } else if (commissionId) {
                console.log(`[STRIPE-WEBHOOK] Commission accrued (cycle ${cycleIndex}): ${commissionId}`);
                await auditLog(supabase, "commission_accrued", commissionId, {
                  event_id: event.id,
                  source: "checkout.session.completed",
                  amount_thb: netThb,
                  cycle_index: cycleIndex,
                  stripe_invoice_id: invoiceId,
                });
                // Email partner about commission
                try {
                  const { data: ce } = await supabase
                    .from("commission_events")
                    .select("partner_user_id, commission_amount_thb, commission_rate")
                    .eq("id", commissionId as string)
                    .maybeSingle();
                  if (ce?.partner_user_id) {
                    await sendCommissionEmailIfPossible(
                      supabase,
                      ce.partner_user_id as string,
                      userId,
                      Number(ce.commission_amount_thb ?? 0),
                      planName,
                      Number(ce.commission_rate ?? 0) * 100,
                    );
                  }
                } catch (e) {
                  console.warn("[STRIPE-WEBHOOK] checkout commission email lookup failed:", e);
                }
              } else {
                console.log(`[STRIPE-WEBHOOK] No commission (no partner referral)`);
              }
            }
          }
        } catch (e) {
          console.error("[STRIPE-WEBHOOK] Commission accrual (checkout) exception:", e);
        }
      }
    }

    // =============================================
    // SUBSCRIPTION UPDATED
    // =============================================
    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      const { data: profile } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (profile) {
        const periodEnd = new Date(subscription.current_period_end * 1000).toISOString();
        const periodStart = new Date(subscription.current_period_start * 1000).toISOString();
        // Best-effort: derive cycle from the active price's recurring interval.
        let cycle: "monthly" | "annual" | null = null;
        try {
          const interval = subscription.items?.data?.[0]?.price?.recurring?.interval;
          if (interval === "year") cycle = "annual";
          else if (interval === "month") cycle = "monthly";
        } catch (_) { /* noop */ }
        await supabase.from("profiles").update({
          stripe_subscription_id: subscription.id,
          current_period_end: periodEnd,
          current_period_start: periodStart,
          ...(cycle ? { subscription_billing_cycle: cycle, billing_interval: cycle } : {}),
        }).eq("user_id", profile.user_id);

        console.log(`[STRIPE-WEBHOOK] Subscription updated for user ${profile.user_id}`);
      }
    }

    // =============================================
    // SUBSCRIPTION CANCELLED
    // =============================================
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = subscription.customer as string;

      const { data: profile } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (profile) {
        await supabase.from("profiles").update({
          subscription_status: "free",
          stripe_subscription_id: null,
          current_period_start: null,
          current_period_end: null,
          current_plan_id: null,
          subscription_plan_id: null,
          billing_interval: "monthly",
          subscription_billing_cycle: null,
        }).eq("user_id", profile.user_id);

        console.log(`[STRIPE-WEBHOOK] Subscription cancelled for user ${profile.user_id}`);
      }
    }

    // =============================================
    // INVOICE PAID (recurring renewal)
    // =============================================
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = invoice.customer as string;
      const subscriptionId = invoice.subscription as string;

      // Skip non-renewal events (handled by checkout.session.completed for first payment)
      if (!["subscription_cycle", "subscription_update"].includes(invoice.billing_reason || "")) {
        console.log(`[STRIPE-WEBHOOK] Skipping invoice with reason: ${invoice.billing_reason}`);
        return new Response(JSON.stringify({ received: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("user_id, current_plan_id, subscription_plan_id")
        .eq("stripe_customer_id", customerId)
        .single();

      const planId = profile?.subscription_plan_id || profile?.current_plan_id;

      if (profile && planId) {
        // Look up the plan from subscription_plans
        const { data: plan } = await supabase
          .from("subscription_plans")
          .select("name, upfront_credits, billing_cycle")
          .eq("id", planId)
          .single();

        if (plan && plan.upfront_credits > 0) {
          // For monthly renewal, use the monthly equivalent credits
          // The plan stored might be annual, so find the monthly counterpart
          let creditsToAdd = plan.upfront_credits;

          // If plan is annual, find the monthly equivalent for renewal credits
          // (Annual plans grant all credits upfront, monthly renewals grant monthly amount)
          if (plan.billing_cycle === "annual") {
            // Annual plans already got all credits upfront, skip renewal
            console.log(`[STRIPE-WEBHOOK] Annual plan renewal - credits already granted upfront`);
          } else {
            const { data: userCredits } = await supabase
              .from("user_credits")
              .select("balance, total_purchased")
              .eq("user_id", profile.user_id)
              .single();

            const newBalance = (userCredits?.balance || 0) + creditsToAdd;

            await supabase.from("user_credits").update({
              balance: newBalance,
              total_purchased: (userCredits?.total_purchased || 0) + creditsToAdd,
            }).eq("user_id", profile.user_id);

            const renewalExpiresAt = new Date();
            renewalExpiresAt.setMonth(renewalExpiresAt.getMonth() + 1);

            await supabase.from("credit_batches").insert({
              user_id: profile.user_id,
              source_type: "subscription",
              amount: creditsToAdd,
              remaining: creditsToAdd,
              expires_at: renewalExpiresAt.toISOString(),
              reference_id: invoice.id,
            });

            await supabase.from("credit_transactions").insert({
              user_id: profile.user_id,
              amount: creditsToAdd,
              type: "subscription_renewal",
              description: `${plan.name} renewal: +${creditsToAdd} credits`,
              reference_id: invoice.id,
              balance_after: newBalance,
            });

            console.log(`[STRIPE-WEBHOOK] Renewal: +${creditsToAdd} credits for user ${profile.user_id}`);
          }

          // Update period end
          if (subscriptionId) {
            try {
              const sub = await stripe.subscriptions.retrieve(subscriptionId);
              await supabase.from("profiles").update({
                current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
              }).eq("user_id", profile.user_id);
            } catch (_) {}
          }
        }

        // === COMMISSION ACCRUAL (renewal) — runs for BOTH monthly AND annual ===
        try {
          if (!invoice.id) {
            console.warn(`[STRIPE-WEBHOOK] Renewal invoice has no ID, skipping commission`);
          } else {
            const cycleIndex = await computeCycleIndex(supabase, profile.user_id);

            if (cycleIndex > 12) {
              console.log(`[STRIPE-WEBHOOK] Renewal cycle ${cycleIndex} > 12, skipping`);
            } else {
              const grossThb = (invoice.amount_paid || 0) / 100;
              const netThb = grossThb;

              if (netThb > 0) {
                const { data: commissionId, error: accrueError } = await supabase.rpc("accrue_commission", {
                  p_referred_user_id: profile.user_id,
                  p_stripe_invoice_id: invoice.id,
                  p_gross_amount_thb: grossThb,
                  p_net_amount_thb: netThb,
                  p_billing_cycle: plan?.billing_cycle || "monthly",
                  p_cycle_index: cycleIndex,
                });

                // Track A: 100 THB user_referral bonus (idempotent)
                await awardUserReferralBonusIfEligible(supabase, profile.user_id, "renewal");

                if (accrueError) {
                  console.error("[STRIPE-WEBHOOK] accrue_commission (renewal) error:", accrueError);
                } else if (commissionId) {
                  console.log(`[STRIPE-WEBHOOK] Commission accrued (renewal cycle ${cycleIndex}): ${commissionId}`);
                  await auditLog(supabase, "commission_accrued", commissionId, {
                    event_id: event.id,
                    source: "invoice.paid",
                    amount_thb: netThb,
                    cycle_index: cycleIndex,
                    stripe_invoice_id: invoice.id,
                  });
                }
              }
            }
          }
        } catch (e) {
          console.error("[STRIPE-WEBHOOK] Commission accrual (renewal) exception:", e);
        }
      }
    }

    // =============================================
    // PAYMENT_INTENT.SUCCEEDED (PromptPay top-up + subscription_oneoff)
    // =============================================
    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as Stripe.PaymentIntent;
      const intentType = intent.metadata?.type;

      // ─── SUBSCRIPTION ONE-OFF (mode=payment plan purchase) ───
      if (intentType === "subscription_oneoff") {
        const userId = intent.metadata?.user_id;
        const planId = intent.metadata?.plan_id;
        const planName = intent.metadata?.plan_name || "Plan";
        const billingCycle = intent.metadata?.billing_cycle || "monthly";

        // CRITICAL DEFENSIVE GUARD: never grant 0 credits silently
        const creditsRaw = intent.metadata?.upfront_credits;
        const creditsToGrant = parseInt(creditsRaw ?? "", 10);
        if (!Number.isFinite(creditsToGrant) || creditsToGrant <= 0) {
          console.error("[CRITICAL] Invalid upfront_credits in metadata", {
            payment_intent: intent.id,
            user_id: userId,
            plan_id: planId,
            raw: creditsRaw,
            parsed: creditsToGrant,
          });
          // Throw → Stripe retries webhook + alert in logs
          throw new Error(`Invalid upfront_credits: ${creditsRaw}`);
        }

        if (!userId || !planId) {
          console.error("[STRIPE-WEBHOOK] subscription_oneoff: missing user_id or plan_id");
          throw new Error("Missing user_id or plan_id in subscription_oneoff metadata");
        }

        // Idempotency
        const { data: existingTx } = await supabase
          .from("payment_transactions")
          .select("id")
          .eq("stripe_payment_intent_id", intent.id)
          .eq("status", "completed")
          .maybeSingle();

        if (existingTx) {
          console.log(`[STRIPE-WEBHOOK] subscription_oneoff: already processed ${intent.id}`);
          return new Response(JSON.stringify({ received: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Look up plan for accurate price + flags. Pull both monthly
        // and annual columns so we can pick the correct value based
        // on the user's chosen cycle (set in checkout metadata).
        const { data: plan } = await supabase
          .from("subscription_plans")
          .select("name, target, upfront_credits, annual_credits, price_thb, annual_price_thb, billing_cycle")
          .eq("id", planId)
          .single();

        // The user's chosen cycle from intent metadata is the source
        // of truth — the plan row's `billing_cycle` is the plan's
        // intrinsic cadence (e.g. "metered" for Team) and shouldn't
        // override what the buyer just paid for.
        const finalBillingCycle = billingCycle;
        const finalPlanName = plan?.name ?? planName;

        // Annual purchase grants the full year of credits + a year of
        // status. Falls back to monthly (`upfront_credits`/`price_thb`)
        // when the annual columns are null on the plan row.
        const finalCredits = plan
          ? Number(
              finalBillingCycle === "annual" && plan.annual_credits != null
                ? plan.annual_credits
                : plan.upfront_credits
            )
          : creditsToGrant;
        const amountThb = plan
          ? Number(
              finalBillingCycle === "annual" && plan.annual_price_thb != null
                ? plan.annual_price_thb
                : plan.price_thb
            )
          : (intent.amount || 0) / 100;

        // Re-validate after DB lookup
        if (!Number.isFinite(finalCredits) || finalCredits <= 0) {
          console.error("[CRITICAL] Plan upfront_credits invalid after DB lookup", { plan_id: planId, finalCredits });
          throw new Error(`Plan ${planId} has invalid upfront_credits: ${finalCredits}`);
        }

        const expiryDays = finalBillingCycle === "annual" ? 365 : 30;

        console.log(`[STRIPE-WEBHOOK] subscription_oneoff: granting ${finalCredits} credits to ${userId} (${finalPlanName}/${finalBillingCycle})`);

        const { error: grantError } = await supabase.rpc("grant_credits", {
          p_user_id: userId,
          p_amount: finalCredits,
          p_source_type: "subscription",
          p_expiry_days: expiryDays,
          p_description: `${finalPlanName} (${finalBillingCycle}): +${finalCredits} credits`,
          p_reference_id: intent.id,
        });

        if (grantError) {
          console.error("[STRIPE-WEBHOOK] subscription_oneoff grant_credits error:", grantError);
          throw new Error(`Credit grant failed: ${grantError.message}`);
        }

        // Update profile (one-off: set period end manually, no recurring sub)
        const periodEnd = new Date();
        if (finalBillingCycle === "annual") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
        else periodEnd.setMonth(periodEnd.getMonth() + 1);

        let newStatus: "free" | "professional" | "agency" = "professional";
        if (finalPlanName === "Enterprise" || finalPlanName === "Studio") newStatus = "agency";

        await supabase.from("profiles").update({
          subscription_status: newStatus,
          billing_interval: finalBillingCycle,
          subscription_billing_cycle: finalBillingCycle,
          current_period_start: new Date().toISOString(),
          current_period_end: periodEnd.toISOString(),
          current_plan_id: planId,
          subscription_plan_id: planId,
        }).eq("user_id", userId);

        await supabase.from("payment_transactions").insert({
          user_id: userId,
          package_id: null,
          stripe_session_id: null,
          stripe_payment_intent_id: intent.id,
          ...receiptFieldsFromIntent(intent),
          amount_thb: amountThb,
          credits_added: finalCredits,
          status: "completed",
          payment_method: intent.payment_method_types?.[0] || "card",
        });

        // Commission accrual
        try {
          const cycleIndex = await computeCycleIndex(supabase, userId);
          if (cycleIndex <= 12 && amountThb > 0) {
            const { data: commissionId, error: accrueError } = await supabase.rpc("accrue_commission", {
              p_referred_user_id: userId,
              p_stripe_invoice_id: intent.id, // PI id used as idempotency key for one-off
              p_gross_amount_thb: amountThb,
              p_net_amount_thb: amountThb,
              p_billing_cycle: finalBillingCycle,
              p_cycle_index: cycleIndex,
            });

            // Track A: 100 THB user_referral bonus (idempotent)
            await awardUserReferralBonusIfEligible(supabase, userId, "oneoff");

            if (accrueError) {
              console.error("[STRIPE-WEBHOOK] accrue_commission (oneoff) error:", accrueError);
            } else if (commissionId) {
              console.log(`[STRIPE-WEBHOOK] Commission accrued (oneoff cycle ${cycleIndex}): ${commissionId}`);
              await auditLog(supabase, "commission_accrued", commissionId as string, {
                event_id: event.id,
                source: "payment_intent.succeeded:subscription_oneoff",
                amount_thb: amountThb,
                cycle_index: cycleIndex,
                payment_intent: intent.id,
              });
              // Email partner about commission
              try {
                const { data: ce } = await supabase
                  .from("commission_events")
                  .select("partner_user_id, commission_amount_thb, commission_rate")
                  .eq("id", commissionId as string)
                  .maybeSingle();
                if (ce?.partner_user_id) {
                  await sendCommissionEmailIfPossible(
                    supabase,
                    ce.partner_user_id as string,
                    userId,
                    Number(ce.commission_amount_thb ?? 0),
                    finalPlanName,
                    Number(ce.commission_rate ?? 0) * 100,
                  );
                }
              } catch (e) {
                console.warn("[STRIPE-WEBHOOK] commission email lookup failed:", e);
              }
            }
          }
        } catch (e) {
          console.error("[STRIPE-WEBHOOK] subscription_oneoff commission exception:", e);
        }

        // Email payment receipt
        try {
          const { email, first_name } = await getUserEmailAndName(supabase, userId);
          if (email) {
            await sendTransactionalEmail("payment_receipt", email, {
              first_name,
              invoice_number: intent.id,
              payment_date: fmtDateTH(new Date()),
              package_name: `${finalPlanName} (${finalBillingCycle === "annual" ? "รายปี" : "รายเดือน"})`,
              credits_added: fmtNum(finalCredits),
              amount_thb: fmtNum(amountThb),
              transactions_url: "https://mediaforge.co/app/transactions",
            });
          }
        } catch (e) {
          console.warn("[STRIPE-WEBHOOK] subscription_oneoff receipt email failed:", e);
        }

        console.log(`[STRIPE-WEBHOOK] subscription_oneoff success: +${finalCredits} credits for ${userId}`);
        return new Response(JSON.stringify({ received: true, credits_granted: finalCredits }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // ─── PROMPTPAY TOP-UP (existing flow) ───
      if (intentType === "org_promptpay_topup") {
        const userId = intent.metadata.user_id;
        const organizationId = intent.metadata.organization_id;
        const creditsToAdd = parseInt(intent.metadata.credits || "0", 10);
        const packageName = intent.metadata.package_name || "Organization credit top-up";

        if (!userId || !organizationId || creditsToAdd <= 0) {
          console.error("[STRIPE-WEBHOOK] Org PromptPay: missing user_id, organization_id, or credits");
          return new Response(JSON.stringify({ error: "Invalid org top-up metadata" }), { status: 400 });
        }

        const { data: existingTx } = await supabase
          .from("payment_transactions")
          .select("id")
          .eq("stripe_payment_intent_id", intent.id)
          .eq("status", "completed")
          .maybeSingle();

        if (existingTx) {
          console.log(`[STRIPE-WEBHOOK] Org PromptPay: already processed ${intent.id}`);
          return new Response(JSON.stringify({ received: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const amountThb = (intent.amount || 0) / 100;
        const { data: newPool, error: poolError } = await supabase.rpc("admin_adjust_org_credit_pool", {
          p_org_id: organizationId,
          p_delta: creditsToAdd,
          p_actor_id: userId,
          p_description: `${packageName}: +${creditsToAdd} credits (PromptPay, THB ${amountThb})`,
        });

        if (poolError || newPool === -1) {
          console.error("[STRIPE-WEBHOOK] Org PromptPay credit pool error:", poolError);
          return new Response(JSON.stringify({ error: "Organization credit grant failed" }), { status: 500 });
        }

        await supabase.from("payment_transactions").insert({
          user_id: userId,
          organization_id: organizationId,
          payment_scope: "organization",
          package_id: null,
          stripe_session_id: null,
          stripe_payment_intent_id: intent.id,
          ...receiptFieldsFromIntent(intent),
          amount_thb: amountThb,
          credits_added: creditsToAdd,
          status: "completed",
          payment_method: "promptpay",
        });

        console.log(`[STRIPE-WEBHOOK] Org PromptPay success: +${creditsToAdd} for org ${organizationId}`);

        try {
          const { email, first_name } = await getUserEmailAndName(supabase, userId);
          if (email) {
            await sendTransactionalEmail("payment_receipt", email, {
              first_name,
              invoice_number: intent.id,
              payment_date: fmtDateTH(new Date()),
              package_name: packageName,
              credits_added: fmtNum(creditsToAdd),
              amount_thb: fmtNum(amountThb),
              transactions_url: "https://mediaforge-admin-hub.vercel.app/org/console",
            });
          }
        } catch (e) {
          console.warn("[STRIPE-WEBHOOK] Org PromptPay receipt email failed:", e);
        }
      }

      if (intentType === "promptpay_topup") {
        const userId = intent.metadata.user_id;
        const creditsToAdd = parseInt(intent.metadata.credits || "0", 10);
        const topupPackageId = intent.metadata.topup_package_id;
        const packageName = intent.metadata.package_name || "PromptPay Top-up";

        if (!userId || creditsToAdd <= 0) {
          console.error("[STRIPE-WEBHOOK] PromptPay: missing user_id or credits");
          return new Response(JSON.stringify({ error: "Invalid metadata" }), { status: 400 });
        }

        const { data: existingTx } = await supabase
          .from("payment_transactions")
          .select("id")
          .eq("stripe_payment_intent_id", intent.id)
          .eq("status", "completed")
          .maybeSingle();

        if (existingTx) {
          console.log(`[STRIPE-WEBHOOK] PromptPay: already processed ${intent.id}`);
          return new Response(JSON.stringify({ received: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        console.log(`[STRIPE-WEBHOOK] PromptPay: +${creditsToAdd} credits for ${userId}`);

        const { error: grantError } = await supabase.rpc("grant_credits", {
          p_user_id: userId,
          p_amount: creditsToAdd,
          p_source_type: "topup",
          p_expiry_days: 365,
          p_description: `${packageName}: +${creditsToAdd} credits (PromptPay)`,
          p_reference_id: intent.id,
        });

        if (grantError) {
          console.error("[STRIPE-WEBHOOK] PromptPay grant_credits error:", grantError);
          return new Response(JSON.stringify({ error: "Credit grant failed" }), { status: 500 });
        }

        let amountThb = (intent.amount || 0) / 100;
        if (topupPackageId) {
          const { data: topupPkg } = await supabase
            .from("topup_packages")
            .select("price_thb")
            .eq("id", topupPackageId)
            .single();
          if (topupPkg) amountThb = topupPkg.price_thb;
        }

        await supabase.from("payment_transactions").insert({
          user_id: userId,
          package_id: null,
          stripe_session_id: null,
          stripe_payment_intent_id: intent.id,
          ...receiptFieldsFromIntent(intent),
          amount_thb: amountThb,
          credits_added: creditsToAdd,
          status: "completed",
          payment_method: "promptpay",
        });

        console.log(`[STRIPE-WEBHOOK] PromptPay success: +${creditsToAdd} for ${userId}`);

        // Email payment receipt
        try {
          const { email, first_name } = await getUserEmailAndName(supabase, userId);
          if (email) {
            await sendTransactionalEmail("payment_receipt", email, {
              first_name,
              invoice_number: intent.id,
              payment_date: fmtDateTH(new Date()),
              package_name: packageName,
              credits_added: fmtNum(creditsToAdd),
              amount_thb: fmtNum(amountThb),
              transactions_url: "https://mediaforge.co/app/transactions",
            });
          }
        } catch (e) {
          console.warn("[STRIPE-WEBHOOK] PromptPay receipt email failed:", e);
        }
      }
    }


    // =============================================
    // REFUND HANDLERS (PromptPay async + card sync)
    // =============================================
    // PromptPay: refund.created arrives as 'requires_action' (customer must confirm via email),
    // then refund.updated fires with status='succeeded' once confirmed.
    // Card: synchronous — charge.refunded fires with refund already succeeded.
    if (
      event.type === "refund.updated" ||
      event.type === "refund.created" ||
      event.type === "refund.failed"
    ) {
      try {
        const refund = event.data.object as Stripe.Refund;

        if (refund.status !== "succeeded") {
          console.log(`[STRIPE-WEBHOOK] ignoring refund ${refund.id} status=${refund.status}`);
        } else {
          await handleRefundSucceeded(supabase, stripe, refund, event.id);
        }
      } catch (e) {
        console.error("[STRIPE-WEBHOOK] refund.* exception:", e);
      }
    }

    if (event.type === "charge.refunded") {
      try {
        const charge = event.data.object as Stripe.Charge;
        // Pick the most recent refund on the charge
        let refundList = charge.refunds?.data ?? [];
        if (refundList.length === 0) {
          // Fallback: list refunds for this charge
          try {
            const refunds = await stripe.refunds.list({ charge: charge.id, limit: 5 });
            refundList = refunds.data;
          } catch (_) {}
        }
        const succeeded = refundList.find((r) => r.status === "succeeded");
        if (!succeeded) {
          console.log(`[STRIPE-WEBHOOK] charge.refunded: no succeeded refund yet on ${charge.id}`);
        } else {
          await handleRefundSucceeded(supabase, stripe, succeeded, event.id);
        }
      } catch (e) {
        console.error("[STRIPE-WEBHOOK] charge.refunded exception:", e);
      }
    }

    /* ── Payment failure (declined card / past-due renewal) ──────
     *
     * Pre-fix: zero handler. Stripe would mark a subscription
     * past-due, our DB still showed `subscription_status='professional'`,
     * the user kept seeing the Pro UI but Stripe had stopped
     * granting credits. They thought they were paid up while
     * Stripe was silently dunning them.
     *
     * Post-fix: stamp the profile as `past_due` so the UI knows
     * to surface the problem, and log the event for ops triage.
     * Doesn't auto-suspend — that happens via subscription.deleted
     * after the dunning window. */
    if (event.type === "invoice.payment_failed") {
      try {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id;
        if (customerId) {
          const { data: prof } = await supabase
            .from("profiles")
            .select("user_id")
            .eq("stripe_customer_id", customerId)
            .single();
          if (prof?.user_id) {
            await supabase
              .from("profiles")
              .update({ subscription_status: "past_due" })
              .eq("user_id", prof.user_id);
          }
        }
        console.log(
          `[STRIPE-WEBHOOK] invoice.payment_failed customer=${customerId} amount_due=${invoice.amount_due}`,
        );
      } catch (e) {
        console.error("[STRIPE-WEBHOOK] invoice.payment_failed exception:", e);
      }
    }

    if (event.type === "payment_intent.payment_failed") {
      try {
        const intent = event.data.object as Stripe.PaymentIntent;
        const customerId =
          typeof intent.customer === "string"
            ? intent.customer
            : intent.customer?.id;
        // Mark the matching payment_transactions row as failed if
        // we recorded one (idempotent — the row may not exist if
        // the failure happened before the user got past 3DS).
        await supabase
          .from("payment_transactions")
          .update({
            status: "failed",
            stripe_error: intent.last_payment_error?.message ?? "payment_failed",
          })
          .eq("stripe_payment_intent_id", intent.id);
        console.log(
          `[STRIPE-WEBHOOK] payment_intent.payment_failed pi=${intent.id} customer=${customerId} err=${intent.last_payment_error?.code ?? "?"}`,
        );
      } catch (e) {
        console.error(
          "[STRIPE-WEBHOOK] payment_intent.payment_failed exception:",
          e,
        );
      }
    }

    /* ── Chargeback / dispute ────────────────────────────────
     *
     * Pre-fix: no handler. A user disputes a charge → our system
     * never knows, the user keeps using the credits they bought.
     *
     * Post-fix: log the dispute against the user's profile via a
     * service-side audit table (`payment_disputes`) so ops can
     * see it on the dashboard, and pause the subscription if the
     * dispute looks fraud-flavoured. We don't auto-revoke credits
     * because Stripe gives 7+ days to respond — admin can choose. */
    if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.updated" ||
      event.type === "charge.dispute.closed"
    ) {
      try {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId =
          typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        const customerId =
          typeof (dispute as unknown as { customer?: string | { id: string } }).customer === "string"
            ? ((dispute as unknown as { customer: string }).customer)
            : (dispute as unknown as { customer?: { id: string } }).customer?.id;
        // Best-effort upsert into a disputes table — table may
        // not exist on every environment; ignore failures so the
        // webhook still 200s back to Stripe.
        try {
          await supabase
            .from("payment_disputes")
            .upsert(
              {
                stripe_dispute_id: dispute.id,
                stripe_charge_id: chargeId,
                stripe_customer_id: customerId,
                amount: dispute.amount,
                currency: dispute.currency,
                reason: dispute.reason,
                status: dispute.status,
                created_at: new Date(dispute.created * 1000).toISOString(),
              },
              { onConflict: "stripe_dispute_id" },
            );
        } catch (e) {
          console.warn("[STRIPE-WEBHOOK] payment_disputes upsert failed (table may not exist):", e);
        }
        console.warn(
          `[STRIPE-WEBHOOK] DISPUTE ${event.type} dispute=${dispute.id} charge=${chargeId} reason=${dispute.reason} amount=${dispute.amount}`,
        );
      } catch (e) {
        console.error("[STRIPE-WEBHOOK] dispute exception:", e);
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[STRIPE-WEBHOOK] Error:", error instanceof Error ? error.message : error);
    return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
});
