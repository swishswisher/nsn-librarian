import type {
  AudienceTag,
  ClassificationResult,
  DocumentPrimaryType,
  OriginalVsSource,
  Publishability,
  TopicTag,
} from "@/types/library";

export type ClassifyDocumentInput = {
  fileName?: string;
  text?: string;
};

const topicKeywordRules: Array<{
  tag: TopicTag;
  keywords: string[];
}> = [
  { tag: "COUPLES", keywords: ["couples", "gottman", "relationship"] },
  { tag: "ATTACHMENT", keywords: ["attachment", "bond", "longing"] },
  { tag: "TRAUMA", keywords: ["trauma", "dissociation"] },
  {
    tag: "AUTISM_NEURODIVERSITY",
    keywords: ["autism", "neurodiversity", "interoception"],
  },
  { tag: "OCD_CERTAINTY", keywords: ["ocd", "certainty", "compulsion"] },
  {
    tag: "ANXIETY_REGULATION",
    keywords: ["anxiety", "regulation", "stress"],
  },
  { tag: "AI_ETHICS", keywords: ["ai", "ethics", "technology"] },
  { tag: "FAMILY_SYSTEMS", keywords: ["family systems", "family"] },
  { tag: "DBT", keywords: ["dbt", "dialectical"] },
  { tag: "MINDFULNESS", keywords: ["mindfulness", "meditation"] },
  { tag: "SOMATIC", keywords: ["somatic", "body"] },
  { tag: "GRIEF", keywords: ["grief", "loss"] },
  { tag: "ADDICTION", keywords: ["addiction", "recovery"] },
  { tag: "NERVOUS_SYSTEM", keywords: ["nervous system", "polyvagal"] },
];

function hasAnyKeyword(haystack: string, keywords: string[]) {
  return keywords.some((keyword) => haystack.includes(keyword));
}

function inferTopicTags(content: string) {
  const matches = topicKeywordRules
    .filter((rule) => hasAnyKeyword(content, rule.keywords))
    .map((rule) => rule.tag);

  return [...new Set(matches)];
}

function inferPrimaryType(content: string): DocumentPrimaryType {
  if (hasAnyKeyword(content, ["infrastructure", "library machine", "taxonomy"])) {
    return "NSN_INFRASTRUCTURE";
  }

  if (hasAnyKeyword(content, ["handoff", "recovery"])) {
    return "HANDOFF";
  }

  if (hasAnyKeyword(content, ["assessment", "intake", "questionnaire"])) {
    return "CLINICAL_ASSESSMENT";
  }

  if (hasAnyKeyword(content, ["worksheet", "handout"])) {
    return "WORKSHEET";
  }

  if (hasAnyKeyword(content, ["research", "nih", "book", "pdf", "source"])) {
    return "RESEARCH_SOURCE";
  }

  if (hasAnyKeyword(content, ["newsletter"])) {
    return "NEWSLETTER_CANDIDATE";
  }

  if (hasAnyKeyword(content, ["article", "essay", "draft"])) {
    return "ARTICLE_CANDIDATE";
  }

  if (hasAnyKeyword(content, ["website", "web copy", "landing page"])) {
    return "WEBSITE_CONTENT";
  }

  if (hasAnyKeyword(content, ["audio", "video", "image", "media"])) {
    return "MEDIA_ASSET";
  }

  return "NEEDS_REVIEW";
}

function inferOriginalVsSource(content: string): OriginalVsSource {
  const sourceSignals = ["research", "nih", "gottman", "source", "citation", "pdf"];
  const originalSignals = ["deanne", "nsn original", "domestic appeal"];

  if (
    hasAnyKeyword(content, sourceSignals) &&
    hasAnyKeyword(content, originalSignals)
  ) {
    return "MIXED";
  }

  if (hasAnyKeyword(content, originalSignals)) {
    return "DEANNE_ORIGINAL";
  }

  if (hasAnyKeyword(content, sourceSignals)) {
    return "OUTSIDE_SOURCE";
  }

  return "UNKNOWN";
}

function inferPublishability(
  content: string,
  originalVsSource: OriginalVsSource,
): Publishability {
  if (hasAnyKeyword(content, ["client", "identifiable", "case note", "session"])) {
    return "CLINICAL_RESTRICTED";
  }

  if (hasAnyKeyword(content, ["do not publish", "private only"])) {
    return "DO_NOT_PUBLISH";
  }

  if (originalVsSource === "OUTSIDE_SOURCE") {
    return "REFERENCE_ONLY";
  }

  if (originalVsSource === "UNKNOWN") {
    return "NEEDS_REVIEW";
  }

  return "INTERNAL_ONLY";
}

function inferAudienceTags(content: string): AudienceTag[] {
  const tags: AudienceTag[] = [];

  if (hasAnyKeyword(content, ["client", "worksheet", "handout"])) {
    tags.push("CLIENT");
  }

  if (hasAnyKeyword(content, ["clinician", "clinical", "assessment"])) {
    tags.push("CLINICIAN");
  }

  if (hasAnyKeyword(content, ["workshop", "speaker", "presentation"])) {
    tags.push("WORKSHOP");
  }

  if (hasAnyKeyword(content, ["research", "source", "nih"])) {
    tags.push("RESEARCH");
  }

  return tags.length > 0 ? tags : ["UNKNOWN"];
}

function inferDestination(
  primaryType: DocumentPrimaryType,
  topicTags: TopicTag[],
): string {
  if (primaryType === "NSN_INFRASTRUCTURE") {
    return "09 NSN Infrastructure";
  }

  if (primaryType === "HANDOFF") {
    return "09 NSN Infrastructure/Handoffs";
  }

  if (primaryType === "WORKSHEET") {
    return "03 WKBK & Worksheets";
  }

  if (primaryType === "RESEARCH_SOURCE") {
    if (topicTags.includes("AI_ETHICS")) {
      return "10 Research Library/AI & Ethics";
    }

    if (topicTags.includes("COUPLES")) {
      return "10 Research Library/Relationships & Couples Research";
    }

    if (topicTags.includes("ATTACHMENT")) {
      return "10 Research Library/Attachment Research";
    }

    if (topicTags.includes("TRAUMA")) {
      return "10 Research Library/Trauma Research";
    }

    return "10 Research Library/Article Source Material";
  }

  if (primaryType === "CLINICAL_ASSESSMENT") {
    return "06 Clinical Library/Assessment Tools/Assessments";
  }

  if (topicTags.includes("COUPLES")) {
    return "06 Clinical Library/Couples/Articles";
  }

  if (topicTags.includes("ATTACHMENT")) {
    return "06 Clinical Library/Attachment/Articles";
  }

  if (topicTags.includes("TRAUMA")) {
    return "06 Clinical Library/Trauma/Articles";
  }

  if (primaryType === "ARTICLE_CANDIDATE") {
    return "01 Articles";
  }

  if (primaryType === "NEWSLETTER_CANDIDATE") {
    return "02 Newsletters";
  }

  return "Needs Review";
}

export async function classifyDocument(
  input: ClassifyDocumentInput,
): Promise<ClassificationResult> {
  const content = `${input.fileName ?? ""} ${input.text ?? ""}`.toLowerCase();
  const topicTags = inferTopicTags(content);
  const primaryType = inferPrimaryType(content);
  const originalVsSource = inferOriginalVsSource(content);
  const publishability = inferPublishability(content, originalVsSource);
  const suggestedDestination = inferDestination(primaryType, topicTags);
  const confidenceScore =
    primaryType === "NEEDS_REVIEW" ? 0.42 : Math.min(0.86, 0.62 + topicTags.length * 0.06);

  return {
    primaryType,
    secondaryTypes: [],
    topicTags,
    audienceTags: inferAudienceTags(content),
    originalVsSource,
    publishability,
    suggestedDestination,
    confidenceScore,
    reasoning:
      topicTags.length > 0
        ? `Matched keyword signals for ${topicTags.join(", ")} and assigned ${primaryType}.`
        : "Insufficient keyword evidence; marked for human review.",
    scores: {
      articleSeedScore: primaryType === "ARTICLE_CANDIDATE" ? 0.72 : 0.2,
      workshopScore: hasAnyKeyword(content, ["workshop", "presentation"]) ? 0.74 : 0.18,
      bookSeedScore: hasAnyKeyword(content, ["book", "chapter"]) ? 0.68 : 0.14,
      clinicalUtilityScore: hasAnyKeyword(content, [
        "clinical",
        "assessment",
        "worksheet",
        "handout",
      ])
        ? 0.78
        : 0.22,
      researchValueScore: primaryType === "RESEARCH_SOURCE" ? 0.82 : 0.2,
      duplicateRiskScore: hasAnyKeyword(content, ["copy", "duplicate", "version"])
        ? 0.66
        : 0.12,
    },
  };
}
