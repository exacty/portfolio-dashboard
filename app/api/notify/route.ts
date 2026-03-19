import { NextResponse } from "next/server";

type NotifyType = "urgent" | "warning" | "info" | "morning_report" | "evening_report";

type NotifyBody =
  | { type: NotifyType; messages: string[] }
  | { type: NotifyType; message: string };

function getTelegramConfig() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return { botToken, chatId };
}

async function sendTelegramMarkdown(text: string) {
  const { botToken, chatId } = getTelegramConfig();
  if (!botToken || !chatId || botToken === "placeholder_setup_later" || chatId === "placeholder_setup_later") {
    // During local/dev without secrets, we just log.
    console.log("[telegram] (placeholder) ", text.slice(0, 500));
    return;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram send failed: ${res.status} ${body}`);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as NotifyBody;

    if (!body || typeof body !== "object" || !("type" in body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const type = body.type as NotifyType;
    const messages =
      "messages" in body && Array.isArray(body.messages)
        ? body.messages
        : "message" in body && typeof body.message === "string"
          ? [body.message]
          : [];

    if (messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    // Fire sequentially to keep rate limits safe.
    for (const msg of messages) {
      await sendTelegramMarkdown(msg);
    }

    return NextResponse.json({ ok: true, type, sent: messages.length });
  } catch (e) {
    return NextResponse.json({ error: "Notify failed", detail: String(e) }, { status: 500 });
  }
}

