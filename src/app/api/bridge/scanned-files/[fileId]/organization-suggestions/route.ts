import { revalidatePath } from "next/cache";

import {
  generateOrganizationSuggestionsForScannedFile,
  OrganizationSuggestionError,
} from "@/lib/bridge/organization-suggestions";
import { BridgeReaderError } from "@/lib/bridge/reader";
import {
  getLegacyOrganizationSuggestionsRoute,
  getRecommendationsRoute,
  getScanSessionRoute,
} from "@/lib/library/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;

  try {
    const result = await generateOrganizationSuggestionsForScannedFile(fileId);
    const scanSessionId = result.file.id
      ? result.suggestions[0]?.scanSessionId
      : null;

    if (scanSessionId) {
      revalidatePath(getScanSessionRoute(scanSessionId));
      revalidatePath(getRecommendationsRoute(scanSessionId));
      revalidatePath(getLegacyOrganizationSuggestionsRoute(scanSessionId));
    }

    return Response.json({
      ok: true,
      file: result.file,
      suggestions: result.suggestions,
      createdCount: result.createdCount,
      existingCount: result.existingCount,
    });
  } catch (error) {
    if (error instanceof OrganizationSuggestionError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    if (error instanceof BridgeReaderError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
        },
        { status: error.statusCode },
      );
    }

    return Response.json(
      {
        ok: false,
        error:
          "The Librarian could not prepare organization recommendations right now.",
      },
      { status: 500 },
    );
  }
}
