import {
  classifyDocument,
  type ClassifyDocumentInput,
} from "@/lib/ai/classify-document";

export async function classifyLibraryDocument(input: ClassifyDocumentInput) {
  return classifyDocument(input);
}
