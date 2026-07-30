# Knowledge Item Architecture

## Purpose

NSN Librarian organizes knowledge, not just documents.

Knowledge is not defined by its format.

A Knowledge Item is any approved item the Librarian may examine, remember, and
eventually help explain or organize. A Knowledge Item may be a document, image,
scan, audio file, video file, email, presentation, spreadsheet, archive, or a
folder-connected item from the future local Bridge.

The user's library remains the source of truth. The database remains the
Librarian's Memory.

## Current Foundation

The current implementation still stores uploaded items in the `LibraryDocument`
model because renaming the model now would create unnecessary risk. The model is
being widened with an `itemKind` field so the system can distinguish the format
of a library item without changing the current upload and Reading Room flow.

Existing uploaded rows default to `DOCUMENT`.

## Knowledge Item Kinds

The prepared item kinds are:

- `DOCUMENT`
- `IMAGE`
- `AUDIO`
- `VIDEO`
- `EMAIL`
- `PRESENTATION`
- `SPREADSHEET`
- `ARCHIVE`
- `UNKNOWN`

These kinds describe the format of an item. They do not decide its value,
meaning, destination, or importance.

## Examiners

The Librarian will eventually use specialized examiners for different item
kinds.

### Reading Room

The Reading Room handles documents. It currently supports:

- TXT
- Markdown
- HTML
- DOCX
- PDF

The Reading Room returns `ReadingResult`, which is the document-specific result
shape used by the current readers.

### Future Image Room

The Image Room will handle images and scans. It is not implemented yet.

### Future Listening Room

The Listening Room will handle audio. It is not implemented yet.

### Future Screening Room

The Screening Room will handle video. It is not implemented yet.

## Standard Extraction Shape

All examiners should eventually return a standardized knowledge extraction
result so the Librarian can reason about observed knowledge without caring which
format produced it.

The prepared broader shape is `KnowledgeExtractionResult`. It supports:

- success
- content text
- summary
- item kind
- examiner type
- word count
- confidence
- warnings
- metadata

The current Reading Room does not need to be rewritten to use this shape today.
It remains stable and document-specific while the wider architecture is prepared.

## Constitutional Boundary

The Librarian never learns from assumptions. It learns from observation.

The human remains in control.

Nothing moves without approval.

The Librarian may examine approved items, remember observations, and make
explainable suggestions. It must not treat file format as identity, and it must
not treat a guess as knowledge.
