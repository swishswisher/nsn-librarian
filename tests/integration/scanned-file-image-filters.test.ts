import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fileMatchesScannedFileFilter,
  filterScannedFiles,
  scannedFileCategoryCounts,
} from "../../src/lib/bridge/scanned-file-filters";
import {
  mediaCategoryForFileType,
  supportedImageFileTypeForPath,
} from "../../src/lib/bridge/media-kind";
import type { BridgeScannedFileSummary } from "../../src/lib/bridge/types";

function suggestionCounts() {
  return {
    approved: 0,
    eligibleForPlanning: 0,
    leftUnchanged: 0,
    modified: 0,
    pending: 0,
    rejected: 0,
    total: 0,
  };
}

function scannedFile(
  relativePath: string,
  overrides: Partial<BridgeScannedFileSummary> = {},
): BridgeScannedFileSummary {
  return {
    audioMetadata: null,
    characterCount: null,
    checksum: null,
    extractedAt: null,
    extractionErrorCategory: null,
    extractionStatus: "PENDING",
    fileType: "IMAGE_JPG",
    hasObservation: false,
    hasPossibleDuplicateSuggestion: false,
    hasReviewedObservation: false,
    id: relativePath,
    imageMetadata: null,
    lastModified: null,
    organizationSuggestionCounts: suggestionCounts(),
    previewText: null,
    processedAt: null,
    processingErrorCategory: null,
    processingStage: "DISCOVERED",
    readingStatus: "NOT_READ",
    readStatus: "SUPPORTED",
    relativePath,
    scanError: null,
    sizeBytes: null,
    sourceCreatedAt: null,
    sourceUnavailableAt: null,
    sourceUnavailableReason: null,
    videoMetadata: null,
    ...overrides,
  };
}

describe("scanned image classification and filters", () => {
  it("includes exact duplicate audio recordings in Possible Duplicates", () => {
    const audioDuplicate = scannedFile(
      "Media/Voice_Intro_Copy.mp3",
      {
        audioMetadata: {
          duplicateKind: "EXACT_DUPLICATE",
        } as BridgeScannedFileSummary["audioMetadata"],
        fileType: "AUDIO_MP3",
      },
    );

    assert.equal(
      fileMatchesScannedFileFilter(audioDuplicate, "POSSIBLE_DUPLICATES"),
      true,
    );
  });

  it("classifies JPG, PNG, and WEBP file names as IMAGE", () => {
    assert.equal(
      mediaCategoryForFileType(
        supportedImageFileTypeForPath("Images/photo.jpg") ?? "UNSUPPORTED",
      ),
      "IMAGE",
    );
    assert.equal(
      mediaCategoryForFileType(
        supportedImageFileTypeForPath("Images/hero.webp") ?? "UNSUPPORTED",
      ),
      "IMAGE",
    );
    assert.equal(
      mediaCategoryForFileType(
        supportedImageFileTypeForPath("Images/slide.PNG") ?? "UNSUPPORTED",
      ),
      "IMAGE",
    );
  });

  it("keeps damaged JPG files in Images and Needs Attention, not Unsupported", () => {
    const damaged = scannedFile("Images/Damaged/broken-image.jpg", {
      extractionErrorCategory: "IMAGE_METADATA_FAILED",
      extractionStatus: "FAILED",
      processingErrorCategory: "IMAGE_METADATA_FAILED",
      processingStage: "FAILED",
      readingStatus: "FAILED",
      scanError: "The Librarian could not inspect this image file safely.",
    });

    assert.equal(fileMatchesScannedFileFilter(damaged, "IMAGES"), true);
    assert.equal(fileMatchesScannedFileFilter(damaged, "FAILED"), true);
    assert.equal(fileMatchesScannedFileFilter(damaged, "UNSUPPORTED"), false);
    assert.deepEqual(scannedFileCategoryCounts([damaged]), {
      audio: 0,
      documents: 0,
      images: 1,
      unsupported: 0,
      video: 0,
    });
  });

  it("returns all image records even when they have no OCR text", () => {
    const files = [
      scannedFile("Documents/note.txt", { fileType: "TEXT" }),
      scannedFile("Images/Website Candidates/becoming-workshop-hero.jpg"),
      scannedFile("Images/Duplicates/becoming-workshop-hero-copy.jpg"),
      scannedFile("Images/Duplicates/becoming-workshop-hero-small.jpg"),
      scannedFile("Images/Text Images/attachment-slide.png", {
        fileType: "IMAGE_PNG",
      }),
      scannedFile("Images/Private/private-family-placeholder.png", {
        fileType: "IMAGE_PNG",
      }),
      scannedFile("Images/Damaged/broken-image.jpg", {
        extractionStatus: "FAILED",
        processingStage: "FAILED",
        readingStatus: "FAILED",
      }),
    ];
    const images = filterScannedFiles(files, "IMAGES");

    assert.equal(images.length, 6);
    assert.ok(images.every((file) => file.previewText === null));
  });

  it("includes private, website candidate, and duplicate images in matching filters", () => {
    const privateImage = scannedFile("Images/Private/private-family-placeholder.png", {
      fileType: "IMAGE_PNG",
    });
    const websiteImage = scannedFile(
      "Images/Website Candidates/becoming-workshop-hero.jpg",
    );
    const exactDuplicate = scannedFile(
      "Images/Duplicates/becoming-workshop-hero-copy.jpg",
    );
    const resizedDuplicate = scannedFile(
      "Images/Duplicates/becoming-workshop-hero-small.jpg",
    );

    assert.equal(fileMatchesScannedFileFilter(privateImage, "PRIVATE"), true);
    assert.equal(
      fileMatchesScannedFileFilter(websiteImage, "WEBSITE_CANDIDATES"),
      true,
    );
    assert.equal(
      fileMatchesScannedFileFilter(exactDuplicate, "POSSIBLE_DUPLICATES"),
      true,
    );
    assert.equal(
      fileMatchesScannedFileFilter(resizedDuplicate, "POSSIBLE_DUPLICATES"),
      true,
    );
    assert.equal(
      fileMatchesScannedFileFilter(privateImage, "WEBSITE_CANDIDATES"),
      false,
    );
  });

  it("does not hide filtered image results behind earlier document rows", () => {
    const documents = Array.from({ length: 40 }, (_, index) =>
      scannedFile(`Documents/doc-${index}.txt`, { fileType: "TEXT" }),
    );
    const images = [
      scannedFile("Images/Website Candidates/becoming-workshop-hero.jpg"),
      scannedFile("Images/Text Images/attachment-slide.png", {
        fileType: "IMAGE_PNG",
      }),
    ];
    const allFiles = [...documents, ...images];

    assert.deepEqual(
      filterScannedFiles(allFiles, "IMAGES").map((file) => file.relativePath),
      images.map((file) => file.relativePath),
    );
  });
});
