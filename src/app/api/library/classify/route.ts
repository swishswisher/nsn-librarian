import { classifyDocument } from "@/lib/ai/classify-document";

type ClassifyRequestBody = {
  fileName?: unknown;
  name?: unknown;
  text?: unknown;
};

function getString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export async function POST(request: Request) {
  let body: ClassifyRequestBody;

  try {
    body = (await request.json()) as ClassifyRequestBody;
  } catch {
    return Response.json(
      { ok: false, error: "Expected a JSON request body." },
      { status: 400 },
    );
  }

  const fileName = getString(body.fileName) ?? getString(body.name);
  const text = getString(body.text);
  const classification = await classifyDocument({ fileName, text });

  return Response.json({
    ok: true,
    classification,
    placeholder: true,
  });
}
