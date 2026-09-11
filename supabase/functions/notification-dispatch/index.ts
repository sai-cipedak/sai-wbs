import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const fromEmail = Deno.env.get("LADUNI_FROM_EMAIL") || "";
const appUrl = Deno.env.get("LADUNI_APP_URL") || "https://sai-cipedak.github.io/sai-wbs/";
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const EVENT_COPY: Record<string, { subject: string; lead: string }> = {
  ASSIGNMENT_ACTION_REQUIRED: { subject: "Tindakan baru diperlukan", lead: "Ada penugasan baru yang memerlukan tindakan Anda." },
  NEW_REPORTER_MESSAGE: { subject: "Pesan baru dari pelapor", lead: "Ada pesan baru dari pelapor yang memerlukan perhatian Anda." },
  NEW_REPORTER_UPDATE: { subject: "Pembaruan baru pada laporan Anda", lead: "Ada pembaruan baru pada laporan Anda." },
  NEW_INTERNAL_COMMENT: { subject: "Komentar internal baru", lead: "Ada komentar internal baru pada kasus yang Anda tangani." },
  CASE_PROGRESS_UPDATE: { subject: "Perkembangan laporan Anda", lead: "Status laporan Anda telah diperbarui." },
  WORKFLOW_ACTION_REQUIRED: { subject: "Workflow memerlukan perhatian", lead: "Ada kasus pada fungsi Anda yang memerlukan perhatian." },
  FOLLOWUP_DUE: { subject: "Follow-up kasus jatuh tempo", lead: "Ada follow-up pasca penutupan yang telah masuk jadwal tindakan." },
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]!));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const suppliedToken = req.headers.get("x-dispatch-token") || "";
  const { data: tokenRows, error: tokenError } = await supabase
    .from("app_settings")
    .select("setting_value")
    .eq("setting_key", "notification_dispatch_token")
    .limit(1);
  const expectedToken = tokenRows?.[0]?.setting_value;
  if (tokenError || typeof expectedToken !== "string" || suppliedToken !== expectedToken) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  if (!resendApiKey || !fromEmail) {
    return new Response(JSON.stringify({ ok: true, configured: false, reason: "RESEND_API_KEY or LADUNI_FROM_EMAIL not configured" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  let requestedLimit = 25;
  try {
    const body = await req.json();
    if (Number.isFinite(body?.limit)) requestedLimit = Math.max(1, Math.min(50, Number(body.limit)));
  } catch (_) {}

  const { data: events, error: queueError } = await supabase
    .from("notification_events")
    .select("id,case_id,event_type,recipient_email,recipient_type,recipient_role,metadata,attempt_count")
    .in("status", ["PENDING", "FAILED"])
    .lt("attempt_count", 5)
    .order("created_at", { ascending: true })
    .limit(requestedLimit);
  if (queueError) return new Response(JSON.stringify({ error: queueError.message }), { status: 500, headers: { "content-type": "application/json" } });

  let sent = 0, failed = 0;
  for (const event of events ?? []) {
    const { data: caseRow } = await supabase
      .from("cases")
      .select("public_case_id,status,authority_code")
      .eq("id", event.case_id)
      .maybeSingle();

    const copy = EVENT_COPY[event.event_type] || { subject: "Pembaruan Laduni SAI", lead: "Ada pembaruan yang memerlukan perhatian Anda." };
    const caseNumber = caseRow?.public_case_id || "Laporan Laduni SAI";
    const status = event.metadata?.status || caseRow?.status || null;
    const role = event.recipient_role || null;
    const subject = `Laduni SAI — ${copy.subject}`;
    const lines = [
      `<p>${escapeHtml(copy.lead)}</p>`,
      `<p><strong>Nomor laporan:</strong> ${escapeHtml(caseNumber)}</p>`,
      status ? `<p><strong>Status:</strong> ${escapeHtml(String(status))}</p>` : "",
      role && event.recipient_type !== "REPORTER" ? `<p><strong>Fungsi:</strong> ${escapeHtml(String(role))}</p>` : "",
      `<p><a href="${escapeHtml(appUrl)}">Buka Laduni SAI</a> untuk melihat detail sesuai hak akses Anda.</p>`,
      `<p style="color:#666;font-size:12px">Untuk menjaga kerahasiaan, detail laporan, identitas pelapor, dan bukti tidak dikirim melalui email.</p>`,
    ].filter(Boolean).join("\n");

    await supabase.from("notification_events").update({
      attempt_count: (event.attempt_count ?? 0) + 1,
      last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", event.id);

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${resendApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromEmail, to: [event.recipient_email], subject, html: lines }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || `Resend HTTP ${response.status}`);
      await supabase.from("notification_events").update({
        status: "SENT", sent_at: new Date().toISOString(), provider_message_id: payload?.id || null,
        error_message: null, updated_at: new Date().toISOString(),
      }).eq("id", event.id);
      sent++;
    } catch (error) {
      await supabase.from("notification_events").update({
        status: "FAILED", error_message: String(error?.message || error).slice(0, 1000), updated_at: new Date().toISOString(),
      }).eq("id", event.id);
      failed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, configured: true, processed: (events ?? []).length, sent, failed }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
