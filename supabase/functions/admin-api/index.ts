/// <reference lib="deno.ns" />
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function clampLimit(raw: unknown, fallback = 50, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

async function verifyAdmin(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const parts = auth.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(Deno.env.get("JWT_SECRET")!),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, "+").replace(/_/g, "/")),
      (c: string) => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (payload.type !== "admin" || payload.exp * 1000 < Date.now()) return null;
    return payload as { sub: string; role: string; email: string; display_name: string };
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const admin = await verifyAdmin(req);
  if (!admin) return json({ error: "Unauthorized" }, 401);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = await req.json();
  const { action } = body;

  try {
    switch (action) {
      case "get_dashboard_stats": {
        const { data, error } = await supabase.rpc("admin_dashboard_stats");
        if (error) return json({ error: error.message }, 500);
        return json(data ?? {
          statusCounts: {},
          pendingReviews: 0,
          totalRevenue: 0,
          totalFlows: 0,
        });
      }

      case "get_review_queue": {
        const { status, page = 0, limit = 20, include_published } = body;
        let query = supabase
          .from("flows")
          .select("id, name, description, status, category, base_cost, api_cost, selling_price, creator_payout, user_id, created_at, updated_at, tags, thumbnail_url")
          .order("updated_at", { ascending: false })
          .range(page * limit, (page + 1) * limit - 1);
        if (status) {
          query = query.eq("status", status);
        } else if (!include_published) {
          query = query.not("status", "in", '("approved","published")');
        }
        const { data, error } = await query;
        if (error) return json({ error: error.message }, 500);

        const flowIds = (data || []).map((f: { id: string }) => f.id);
        const reviewCounts: Record<string, number> = {};
        if (flowIds.length > 0) {
          const { data: reviews } = await supabase
            .from("flow_reviews")
            .select("flow_id")
            .in("flow_id", flowIds);
          (reviews || []).forEach((r: { flow_id: string }) => {
            reviewCounts[r.flow_id] = (reviewCounts[r.flow_id] || 0) + 1;
          });
        }

        const flows = (data || []).map((f: any) => ({
          ...f,
          review_count: reviewCounts[f.id] || 0,
        }));
        return json({ flows });
      }

      case "get_flow_detail": {
        const { flow_id, reviews_page = 0, reviews_limit = 50 } = body;
        if (!flow_id) return json({ error: "flow_id required" }, 400);
        const reviewPage = clampPage(reviews_page);
        const reviewLimit = clampLimit(reviews_limit, 50, 100);
        const [flowRes, nodesRes, reviewsRes, badgesRes] = await Promise.all([
          supabase.from("flows").select("*").eq("id", flow_id).single(),
          supabase.from("flow_nodes").select("*").eq("flow_id", flow_id).order("sort_order"),
          supabase
            .from("flow_reviews")
            .select("*", { count: "exact" })
            .eq("flow_id", flow_id)
            .order("created_at", { ascending: false })
            .range(reviewPage * reviewLimit, (reviewPage + 1) * reviewLimit - 1),
          supabase.from("flow_badges").select("*").eq("flow_id", flow_id),
        ]);
        if (flowRes.error) return json({ error: flowRes.error.message }, 404);
        return json({
          flow: flowRes.data,
          nodes: nodesRes.data || [],
          reviews: reviewsRes.data || [],
          reviews_total: reviewsRes.count || 0,
          reviews_page: reviewPage,
          reviews_limit: reviewLimit,
          badges: badgesRes.data || [],
        });
      }

      case "submit_review": {
        const {
          flow_id, output_quality, consistency, commercial_usability,
          originality, efficiency, workflow_clarity, safety,
          decision, reviewer_notes, internal_notes,
        } = body;
        if (!flow_id || !decision) return json({ error: "flow_id and decision required" }, 400);

        // Note: total_score is a GENERATED column in DB — do NOT insert it
        const { error: reviewError } = await supabase.from("flow_reviews").insert({
          flow_id,
          reviewer_id: admin.sub,
          output_quality: output_quality || 0,
          consistency: consistency || 0,
          commercial_usability: commercial_usability || 0,
          originality: originality || 0,
          efficiency: efficiency || 0,
          workflow_clarity: workflow_clarity || 0,
          safety: safety || 0,
          decision,
          reviewer_notes: reviewer_notes || null,
          internal_notes: internal_notes || null,
        });
        if (reviewError) return json({ error: reviewError.message }, 500);

        // Update flow status and flat pricing
        const newStatus = decision === "approved" ? "published" : decision === "rejected" ? "rejected" : "changes_requested";
        const updateData: Record<string, unknown> = { status: newStatus };

        const { data: flowOwner } = await supabase.from("flows").select("user_id, name, base_cost").eq("id", flow_id).single();

        if (decision === "approved") {
          // Flat pricing: 2.5x multiplier, 20% revshare
          const apiCost = flowOwner?.base_cost || 0;
          const multiplier = 4.0;
          const revshare = 0.2;
          const sellingPrice = Math.ceil(apiCost * multiplier);
          const margin = sellingPrice - apiCost;
          const payout = Math.ceil(margin * revshare);
          Object.assign(updateData, {
            api_cost: apiCost,
            selling_price: sellingPrice,
            contribution_margin: margin,
            creator_payout: payout,
            markup_multiplier: multiplier,
          });
        }

        const { error: updateError } = await supabase.from("flows").update(updateData).eq("id", flow_id);
        if (updateError) return json({ error: updateError.message }, 500);

        // Send notification to creator
        if (flowOwner?.user_id) {
          const notifMap: Record<string, { title: string; message: string; icon: string }> = {
            approved: {
              title: "🎉 Flow Approved & Published!",
              message: `Your flow "${flowOwner.name}" has been approved and published.`,
              icon: "check-circle",
            },
            rejected: {
              title: "Flow Rejected",
              message: `Your flow "${flowOwner.name}" was not approved. Check the feedback for details.`,
              icon: "x-circle",
            },
            changes_requested: {
              title: "Changes Requested",
              message: `Your flow "${flowOwner.name}" needs revisions. Please review the feedback and resubmit.`,
              icon: "message-square",
            },
          };
          const notif = notifMap[decision];
          if (notif) {
            await supabase.from("notifications").insert({
              user_id: flowOwner.user_id,
              type: "flow_review",
              title: notif.title,
              message: notif.message,
              icon: notif.icon,
              link: "/creator/flows",
              metadata: { flow_id, decision },
            });
          }
        }

        return json({ success: true, status: newStatus });
      }

      case "publish_flow": {
        const { flow_id } = body;
        const { error } = await supabase.from("flows").update({ status: "published" }).eq("id", flow_id).eq("status", "approved");
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      case "unpublish_flow": {
        const { flow_id, reason } = body;
        if (!flow_id) return json({ error: "flow_id required" }, 400);
        const { error } = await supabase.from("flows").update({ status: "submitted" }).eq("id", flow_id).eq("status", "published");
        if (error) return json({ error: error.message }, 500);

        const { data: flowData } = await supabase.from("flows").select("user_id, name").eq("id", flow_id).single();
        if (flowData?.user_id) {
          await supabase.from("notifications").insert({
            user_id: flowData.user_id,
            type: "flow_review",
            title: "Flow Sent Back for Review",
            message: `Your flow "${flowData.name}" has been unpublished and sent back for review.${reason ? ` Reason: ${reason}` : ""}`,
            icon: "alert-circle",
            link: "/creator/flows",
            metadata: { flow_id, action: "unpublished" },
          });
        }
        return json({ success: true });
      }

      case "manage_badge": {
        const { flow_id, badge, remove } = body;
        if (remove) {
          await supabase.from("flow_badges").delete().eq("flow_id", flow_id).eq("badge", badge);
        } else {
          await supabase.from("flow_badges").upsert({ flow_id, badge, assigned_by: admin.sub }, { onConflict: "flow_id,badge" });
        }
        return json({ success: true });
      }

      case "list_admins": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { page = 0, limit = 100 } = body;
        const safePage = clampPage(page);
        const safeLimit = clampLimit(limit, 100, 100);
        const { data, count } = await supabase
          .from("admin_accounts")
          .select("id, email, display_name, admin_role, is_active, last_login_at, created_at", { count: "exact" })
          .order("created_at")
          .range(safePage * safeLimit, (safePage + 1) * safeLimit - 1);
        return json({ admins: data || [], total: count || 0, page: safePage, limit: safeLimit });
      }

      case "create_admin": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { email, password, display_name, admin_role } = body;
        if (!email || !password || !display_name) return json({ error: "Missing fields" }, 400);

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const enc = new TextEncoder();
        const km = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
        const hash = btoa(String.fromCharCode(...salt)) + ":" + btoa(String.fromCharCode(...new Uint8Array(bits)));

        const { data, error } = await supabase.from("admin_accounts").insert({
          email,
          password_hash: hash,
          display_name,
          admin_role: admin_role || "review_admin",
          created_by: admin.sub,
        }).select("id, email, display_name, admin_role").single();
        if (error) return json({ error: error.message }, 500);
        return json({ admin: data });
      }

      case "toggle_admin_active": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { admin_id, is_active } = body;
        await supabase.from("admin_accounts").update({ is_active }).eq("id", admin_id);
        return json({ success: true });
      }

      case "bulk_review": {
        const { flow_ids, decision: bulkDecision } = body;
        if (!flow_ids?.length || !bulkDecision) return json({ error: "flow_ids and decision required" }, 400);
        const newStatus = bulkDecision === "approved" ? "approved" : bulkDecision === "rejected" ? "rejected" : "changes_requested";
        
        const notifMap: Record<string, { title: string; icon: string }> = {
          approved: { title: "🎉 Flow Approved!", icon: "check-circle" },
          rejected: { title: "Flow Rejected", icon: "x-circle" },
          changes_requested: { title: "Changes Requested", icon: "message-square" },
        };

        for (const fid of flow_ids) {
          await supabase.from("flow_reviews").insert({
            flow_id: fid,
            reviewer_id: admin.sub,
            decision: bulkDecision,
            reviewer_notes: body.reviewer_notes || null,
          });
          await supabase.from("flows").update({ status: newStatus }).eq("id", fid);

          const { data: flowData } = await supabase.from("flows").select("user_id, name").eq("id", fid).single();
          if (flowData?.user_id) {
            const notif = notifMap[bulkDecision];
            const messageMap: Record<string, string> = {
              approved: `Your flow "${flowData.name}" has been approved.`,
              rejected: `Your flow "${flowData.name}" was not approved.`,
              changes_requested: `Your flow "${flowData.name}" needs revisions.`,
            };
            await supabase.from("notifications").insert({
              user_id: flowData.user_id,
              type: "flow_review",
              title: notif?.title || "Flow Update",
              message: messageMap[bulkDecision] || "Your flow status has been updated.",
              icon: notif?.icon || "bell",
              link: "/creator/flows",
              metadata: { flow_id: fid, decision: bulkDecision },
            });
          }
        }
        return json({ success: true, count: flow_ids.length });
      }

      /* ── Homepage Section Management ── */

      case "list_homepage_sections": {
        const { data: sections, error } = await supabase
          .from("homepage_sections")
          .select("*")
          .order("sort_order")
          .limit(100);
        if (error) return json({ error: error.message }, 500);

        const sectionIds = (sections || []).map((s: any) => s.id);
        const { data: featured } = await supabase
          .from("homepage_featured")
          .select("id, flow_id, section_id, sort_order, is_active, flows(id, name, thumbnail_url, status, category, selling_price)")
          .in("section_id", sectionIds.length ? sectionIds : ["00000000-0000-0000-0000-000000000000"])
          .order("sort_order")
          .limit(500);

        const featuredBySection: Record<string, any[]> = {};
        (featured || []).forEach((f: any) => {
          if (!featuredBySection[f.section_id]) featuredBySection[f.section_id] = [];
          featuredBySection[f.section_id].push(f);
        });

        return json({
          sections: (sections || []).map((s: any) => ({
            ...s,
            featured_flows: featuredBySection[s.id] || [],
          })),
        });
      }

      case "upsert_homepage_section": {
        const { section_id, title, subtitle, icon, sort_order, section_type, max_items, auto_fill_strategy, is_active } = body;
        if (!title) return json({ error: "title required" }, 400);
        const payload: Record<string, unknown> = { title, subtitle, icon, sort_order, section_type, max_items, auto_fill_strategy, is_active, updated_at: new Date().toISOString() };
        let result;
        if (section_id) {
          result = await supabase.from("homepage_sections").update(payload).eq("id", section_id).select().single();
        } else {
          result = await supabase.from("homepage_sections").insert(payload).select().single();
        }
        if (result.error) return json({ error: result.error.message }, 500);
        return json({ section: result.data });
      }

      case "delete_homepage_section": {
        const { section_id } = body;
        if (!section_id) return json({ error: "section_id required" }, 400);
        const { error } = await supabase.from("homepage_sections").delete().eq("id", section_id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      case "reorder_sections": {
        const { order } = body;
        if (!Array.isArray(order)) return json({ error: "order array required" }, 400);
        for (const item of order) {
          await supabase.from("homepage_sections").update({ sort_order: item.sort_order }).eq("id", item.id);
        }
        return json({ success: true });
      }

      case "assign_flow_to_section": {
        const { section_id, flow_id: assignFlowId } = body;
        if (!section_id || !assignFlowId) return json({ error: "section_id and flow_id required" }, 400);
        const { data: existing } = await supabase
          .from("homepage_featured")
          .select("sort_order")
          .eq("section_id", section_id)
          .order("sort_order", { ascending: false })
          .limit(1);
        const nextOrder = ((existing?.[0]?.sort_order ?? -1) as number) + 1;
        const { error } = await supabase.from("homepage_featured").insert({
          section_id,
          flow_id: assignFlowId,
          sort_order: nextOrder,
          slot: "curated",
        });
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      case "remove_flow_from_section": {
        const { featured_id } = body;
        if (!featured_id) return json({ error: "featured_id required" }, 400);
        const { error } = await supabase.from("homepage_featured").delete().eq("id", featured_id);
        if (error) return json({ error: error.message }, 500);
        return json({ success: true });
      }

      case "search_published_flows": {
        const { query: searchQuery, limit: searchLimit = 20 } = body;
        let q = supabase
          .from("flows")
          .select("id, name, thumbnail_url, category, selling_price, status")
          .eq("status", "published")
          .order("created_at", { ascending: false })
          .limit(searchLimit);
        if (searchQuery) q = q.ilike("name", `%${searchQuery}%`);
        const { data, error } = await q;
        if (error) return json({ error: error.message }, 500);
        return json({ flows: data || [] });
      }

      /* ── User Management ── */

      case "list_users": {
        const { search: userSearch, page = 0, limit = 20 } = body;
        let q = supabase
          .from("profiles")
          .select("id, user_id, display_name, avatar_url, is_official, created_at")
          .order("created_at", { ascending: false })
          .range(page * limit, (page + 1) * limit - 1);
        if (userSearch) {
          q = q.or(`display_name.ilike.%${userSearch}%`);
        }
        const { data: profiles, error: profErr } = await q;
        if (profErr) return json({ error: profErr.message }, 500);

        const userIds = (profiles || []).map((p: any) => p.user_id);
        if (userIds.length === 0) return json({ users: [] });

        const [creditsRes, flowsRes] = await Promise.all([
          supabase.from("user_credits").select("user_id, balance").in("user_id", userIds),
          supabase.from("flows").select("user_id").in("user_id", userIds),
        ]);

        const creditsMap: Record<string, number> = {};
        (creditsRes.data || []).forEach((c: any) => { creditsMap[c.user_id] = c.balance; });
        const flowCountMap: Record<string, number> = {};
        (flowsRes.data || []).forEach((f: any) => { flowCountMap[f.user_id] = (flowCountMap[f.user_id] || 0) + 1; });

        const users = (profiles || []).map((p: any) => ({
          ...p,
          credits_balance: creditsMap[p.user_id] ?? 0,
          flows_count: flowCountMap[p.user_id] ?? 0,
        }));
        return json({ users });
      }

      case "get_user_detail": {
        const { user_id: targetUserId, flows_page = 0, flows_limit = 50 } = body;
        if (!targetUserId) return json({ error: "user_id required" }, 400);
        const flowsPage = clampPage(flows_page);
        const flowsLimit = clampLimit(flows_limit, 50, 100);

        const [profileRes, creditsRes, txRes, runsRes] = await Promise.all([
          supabase.from("profiles").select("*").eq("user_id", targetUserId).single(),
          supabase.from("user_credits").select("*").eq("user_id", targetUserId).single(),
          supabase.from("credit_transactions").select("*").eq("user_id", targetUserId).order("created_at", { ascending: false }).limit(50),
          supabase.from("flow_runs").select("id, flow_id, status, credits_used, started_at, completed_at, duration_ms").eq("user_id", targetUserId).order("started_at", { ascending: false }).limit(50),
         ]);

        const { data: flowsData, count: flowsTotal } = await supabase
          .from("flows")
          .select("id, name, status, is_official, created_at", { count: "exact" })
          .eq("user_id", targetUserId)
          .order("created_at", { ascending: false })
          .range(flowsPage * flowsLimit, (flowsPage + 1) * flowsLimit - 1);

        return json({
          profile: profileRes.data,
          credits: creditsRes.data,
          transactions: txRes.data || [],
          flow_runs: runsRes.data || [],
          flows: flowsData || [],
          flows_total: flowsTotal || 0,
          flows_page: flowsPage,
          flows_limit: flowsLimit,
        });
      }

      case "get_user_logs": {
        const { user_id: logUserId, log_type = "transactions", page = 0, limit = 50 } = body;
        if (!logUserId) return json({ error: "user_id required" }, 400);
        const safePage = clampPage(page);
        const safeLimit = clampLimit(limit, 50, 100);

        if (log_type === "transactions") {
          const { data, error } = await supabase.from("credit_transactions").select("*").eq("user_id", logUserId).order("created_at", { ascending: false }).range(safePage * safeLimit, (safePage + 1) * safeLimit - 1);
          if (error) return json({ error: error.message }, 500);
          return json({ logs: data || [], page: safePage, limit: safeLimit });
        } else if (log_type === "flow_runs") {
          const { data, error } = await supabase.from("flow_runs").select("id, flow_id, status, credits_used, started_at, completed_at, duration_ms, error_message").eq("user_id", logUserId).order("started_at", { ascending: false }).range(safePage * safeLimit, (safePage + 1) * safeLimit - 1);
          if (error) return json({ error: error.message }, 500);
          return json({ logs: data || [], page: safePage, limit: safeLimit });
        }
        return json({ error: "Invalid log_type" }, 400);
      }

      case "adjust_user_credits": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { user_id: creditUserId, amount: creditAmount, reason } = body;
        if (!creditUserId || !creditAmount) return json({ error: "user_id and amount required" }, 400);

        const numAmount = Number(creditAmount);
        if (isNaN(numAmount) || numAmount === 0) return json({ error: "Invalid amount" }, 400);

        // Update balance
        const { data: currentCredits } = await supabase.from("user_credits").select("balance").eq("user_id", creditUserId).single();
        const currentBalance = currentCredits?.balance ?? 0;
        const newBalance = Math.max(0, currentBalance + numAmount);

        await supabase.from("user_credits").update({
          balance: newBalance,
          total_purchased: numAmount > 0 ? currentBalance + numAmount : undefined,
          updated_at: new Date().toISOString(),
        }).eq("user_id", creditUserId);

        // Create batch for additions
        if (numAmount > 0) {
          await supabase.from("credit_batches").insert({
            user_id: creditUserId,
            amount: numAmount,
            remaining: numAmount,
            source_type: "topup",
            expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
            reference_id: `admin-adjust-${admin.sub}-${Date.now()}`,
          });
        }

        // Record transaction
        await supabase.from("credit_transactions").insert({
          user_id: creditUserId,
          amount: numAmount,
          type: "admin_adjustment",
          feature: "admin",
          description: reason || `Admin adjustment by ${admin.display_name}`,
          balance_after: newBalance,
        });

        // Audit log
        await supabase.from("admin_audit_logs").insert({
          admin_user_id: admin.sub,
          action: "adjust_credits",
          target_table: "user_credits",
          target_user_id: creditUserId,
          details: { amount: numAmount, reason, new_balance: newBalance },
        });

        return json({ success: true, new_balance: newBalance });
      }

      case "toggle_official": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { user_id: officialUserId, is_official: setOfficial } = body;
        if (!officialUserId || typeof setOfficial !== "boolean") return json({ error: "user_id and is_official required" }, 400);

        // Update profile
        const { error: profError } = await supabase.from("profiles").update({ is_official: setOfficial }).eq("user_id", officialUserId);
        if (profError) return json({ error: profError.message }, 500);

        // Bulk-update all flows by this user
        const { error: flowError } = await supabase.from("flows").update({ is_official: setOfficial }).eq("user_id", officialUserId);
        if (flowError) return json({ error: flowError.message }, 500);

        // Audit log
        await supabase.from("admin_audit_logs").insert({
          admin_user_id: admin.sub,
          action: setOfficial ? "promote_official" : "demote_official",
          target_table: "profiles",
          target_user_id: officialUserId,
          details: { is_official: setOfficial },
        });

        return json({ success: true });
      }

      /* ─── Credit Costs CRUD ─── */

      case "fetch_credit_costs": {
        const { data, error } = await supabase
          .from("credit_costs")
          .select("*")
          .order("feature")
          .order("cost", { ascending: true });
        if (error) return json({ error: error.message }, 500);
        return json({ data });
      }

      case "upsert_credit_cost": {
        const { id, feature, model, label, cost, pricing_type, duration_seconds, has_audio } = body;
        if (!feature || !label || cost == null) return json({ error: "feature, label, cost required" }, 400);
        const row = {
          feature,
          model: model || null,
          label,
          cost: Number(cost),
          pricing_type: pricing_type || "per_operation",
          duration_seconds: feature === "generate_freepik_video" ? (duration_seconds ?? null) : null,
          has_audio: feature === "generate_freepik_video" ? (has_audio ?? false) : false,
        };
        if (id) {
          const { error: upErr } = await supabase.from("credit_costs").update(row).eq("id", id);
          if (upErr) return json({ error: upErr.message }, 500);
        } else {
          const { error: insErr } = await supabase.from("credit_costs").insert(row);
          if (insErr) return json({ error: insErr.message }, 500);
        }
        await supabase.from("admin_audit_logs").insert({
          admin_user_id: admin.sub,
          action: id ? "update_credit_cost" : "create_credit_cost",
          target_table: "credit_costs",
          details: { ...row, id },
        });
        return json({ success: true });
      }

      case "delete_credit_cost": {
        const { id: deleteId } = body;
        if (!deleteId) return json({ error: "id required" }, 400);
        const { error: delErr } = await supabase.from("credit_costs").delete().eq("id", deleteId);
        if (delErr) return json({ error: delErr.message }, 500);
        await supabase.from("admin_audit_logs").insert({
          admin_user_id: admin.sub,
          action: "delete_credit_cost",
          target_table: "credit_costs",
          details: { id: deleteId },
        });
        return json({ success: true });
      }

      /* ── Platform Markup Multipliers ── */

      case "get_markup_multipliers": {
        const { data, error } = await supabase
          .from("subscription_settings")
          .select("key, value")
          .in("key", ["markup_multiplier_image", "markup_multiplier_video", "markup_multiplier_chat"]);
        if (error) return json({ error: error.message }, 500);
        const multipliers: Record<string, number> = {};
        (data || []).forEach((r: any) => {
          multipliers[r.key] = parseFloat(r.value) || 4.0;
        });
        return json({
          image: multipliers.markup_multiplier_image ?? 4.0,
          video: multipliers.markup_multiplier_video ?? 4.0,
          chat: multipliers.markup_multiplier_chat ?? 4.0,
        });
      }

      case "set_markup_multipliers": {
        if (admin.role !== "super_admin") return json({ error: "Super admin required" }, 403);
        const { image, video, chat } = body;
        const updates: { key: string; value: string }[] = [];
        if (image != null) updates.push({ key: "markup_multiplier_image", value: String(Number(image)) });
        if (video != null) updates.push({ key: "markup_multiplier_video", value: String(Number(video)) });
        if (chat != null) updates.push({ key: "markup_multiplier_chat", value: String(Number(chat)) });

        for (const u of updates) {
          // Use upsert to handle both existing and missing rows
          const { error: upErr } = await supabase
            .from("subscription_settings")
            .upsert(
              { key: u.key, value: u.value, updated_at: new Date().toISOString() },
              { onConflict: "key" }
            );
          if (upErr) {
            console.error(`[set_markup_multipliers] upsert error for ${u.key}:`, upErr);
            return json({ error: upErr.message }, 500);
          }
        }

        // Verify the write persisted
        const { data: verify } = await supabase
          .from("subscription_settings")
          .select("key, value")
          .in("key", updates.map(u => u.key));
        console.log("[set_markup_multipliers] verified values:", JSON.stringify(verify));

        await supabase.from("admin_audit_logs").insert({
          admin_user_id: admin.sub,
          action: "update_markup_multipliers",
          target_table: "subscription_settings",
          details: { image, video, chat },
        });

        return json({ success: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
});
