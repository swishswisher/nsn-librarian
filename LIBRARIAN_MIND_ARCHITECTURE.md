# Librarian Mind Architecture

## Purpose

The Librarian's Mind exists so reasoning has a clear home.

UI components, upload handlers, readers, and storage services should not call AI
models directly. They should pass observed knowledge into the Mind and receive
explainable observations, interpretations, suggestions, and uncertainty.

Claude is not the Mind. Claude is a tool, not the Librarian. Claude may later
become one reasoning engine used by the Mind, but the Mind remains the product
boundary that protects human authority, observation-first reasoning, and
approval-based action.

## Core Principles

- The machine suggests. Deanne decides.
- Nothing moves without approval.
- The Librarian never learns from assumptions. It learns from observation.
- Knowledge is not defined by its format.
- The Human always has final authority.
- Claude is a tool, not the Librarian.

## Faculty Model

The Mind is organized into five faculties.

### Observer

The Observer inspects what has been observed. Today it uses deterministic local
logic only. It can notice empty content, repeated terms, major recurring words,
item format context, and cautious purpose signals.

The Observer does not diagnose, classify with certainty, or make clinical
conclusions.

### Reasoner

The Reasoner turns observations into cautious interpretations.

Observation comes before interpretation. An interpretation must be traceable to
observation ids, and uncertainty must stay visible.

### Connector

The Connector will eventually map relationships between knowledge items.

For now it returns no connections. Vector search, similarity search, and related
item queries are intentionally not implemented in this milestone.

### Explainer

The Explainer turns observations and interpretations into calm, readable
language. It explains what was noticed, why it may matter, what remains
uncertain, and why human review is still required.

### Planner

The Planner prepares possible human-review suggestions.

It never executes actions. Every plan suggestion requires human approval. A plan
is not permission to move, rename, delete, reorganize, or remember a final
decision.

## System Flow

Reading Room -> Librarian's Mind -> Librarian's Memory -> Suggestions -> Human Decision

The Reading Room extracts text from supported documents. The Mind observes and
reasons about that extracted knowledge. The Librarian's Memory may later store
approved observations, decisions, and relationships. Suggestions are shown to
the human. The human decides.

## Claude Boundary

Claude should not be called directly from UI components, upload handlers,
readers, or random services.

When Claude is added later, it should be called through a reasoning engine
inside the Mind. That engine should receive structured inputs, return structured
outputs, preserve evidence and uncertainty, and remain subordinate to the Mind's
constitutional rules.

## Current Milestone

This milestone adds the inactive foundation only:

- `MindInput`
- `Observation`
- `Interpretation`
- `Connection`
- `Explanation`
- `PlanSuggestion`
- `MindResult`
- Observer
- Reasoner
- Connector
- Explainer
- Planner
- `runLibrarianMind`

Nothing is wired into the active upload, Reading Room, classification, review,
or migration flows yet.

## Human Approval

The Mind may suggest.

The human decides.

Nothing moves without approval.

The Mind must admit uncertainty and preserve evidence so the human can see why a
suggestion exists.
