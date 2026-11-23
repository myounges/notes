"""Auto-tagging classifier (A+B): keyword rules + sentence embeddings.

Option A (deterministic override): each tag has a small keyword list — a mere
2+ hit of distinctive terms returns that tag straight away, no model needed.

Option B (semantic): note text is embedded with a small sentence-transformer
(all-MiniLM-L6-v2, ~90MB, CPU-only) and compared against per-tag centroids
built from a few hand-written exemplar sentences. This is what gives short,
keyword-free notes (\"wash the car\", \"new tires\") a reliable tag via
paraphrase overlap. MiniLM is a *sentence* model, so short text is its home
ground, not its weakness.

Classification is vocabulary-bound either way: tags are always drawn from
TAGS, so a run can never invent hundreds of new tags.
"""
from __future__ import annotations

import logging
import os
import re

import numpy as np

log = logging.getLogger("worker.tagging")

# Model weights live in /models (shared volume); ocr.py already sets HF_HOME,
# this is a belt-and-braces default for direct imports.
os.environ.setdefault("HF_HOME", os.environ.get("MODEL_CACHE_DIR", "/models"))
os.environ.setdefault("HF_HUB_CACHE", os.environ.get("MODEL_CACHE_DIR", "/models"))

EMBED_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"

# Option B: centroid cosine similarity must reach this to be tagged.
VECTOR_MIN = 0.32
VECTOR_TOPK = 2
# Option A: cumulative keyword weight needed to force a tag.
KEYWORD_MIN = 2.0

# Each tag: unique-ish keywords (weight 1-2) and exemplar sentences whose
# centroid defines where that tag "lives" in embedding space.
TAGS: list[dict] = [
    {
        "name": "Work",
        "keywords": {
            "meeting": 2,
            "deadline": 2,
            "project": 2,
            "standup": 2,
            "sprint": 2,
            "client": 2,
            "manager": 2,
            "office": 1,
            "work": 1,
            "colleague": 2,
            "report": 1,
            "task": 1,
        },
        "exemplars": [
            "project kickoff meeting notes",
            "deadline for the quarterly report",
            "weekly standup with the team",
            "work tasks for the client presentation",
            "conversation with my manager about the roadmap",
        ],
    },
    {
        "name": "Personal",
        "keywords": {
            "birthday": 2,
            "family": 2,
            "friends": 2,
            "personal": 2,
            "hobby": 2,
            "party": 2,
            "celebration": 2,
            "weekend": 1,
            "gift": 1,
        },
        "exemplars": [
            "birthday gift ideas for mom",
            "family dinner plans for the weekend",
            "hanging out with friends",
            "personal goals for this year",
            "celebrating the new year together",
        ],
    },
    {
        "name": "Ideas",
        "keywords": {
            "idea": 2,
            "concept": 2,
            "brainstorm": 2,
            "inspiration": 2,
            "sketch": 2,
            "prototype": 2,
            "invention": 2,
            "vision": 2,
            "thought": 1,
        },
        "exemplars": [
            "idea for a new app concept",
            "brainstorming product features",
            "a prototype sketch with rough notes",
            "inspiring thought for a side project",
            "writing down random ideas before bed",
        ],
    },
    {
        "name": "Finance",
        "keywords": {
            "invoice": 2,
            "budget": 2,
            "expense": 2,
            "salary": 2,
            "tax": 2,
            "bank": 2,
            "receipt": 2,
            "mortgage": 2,
            "loan": 2,
            "invest": 2,
            "money": 1,
            "payment": 1,
            "bill": 1,
        },
        "exemplars": [
            "monthly budget breakdown",
            "invoice for the consulting work",
            "tracking expenses and receipts",
            "paying the electricity bill",
            "savings goals and investment plans",
        ],
    },
    {
        "name": "Travel",
        "keywords": {
            "flight": 2,
            "hotel": 2,
            "trip": 2,
            "travel": 2,
            "airport": 2,
            "vacation": 2,
            "passport": 2,
            "visa": 2,
            "itinerary": 2,
            "luggage": 2,
            "abroad": 2,
            "train": 1,
            "booking": 1,
            "destination": 2,
        },
        "exemplars": [
            "booking flights to lisbon",
            "hotel and itinerary for the trip",
            "passport and visa documents",
            "vacation packing list",
            "train tickets for the weekend away",
        ],
    },
    {
        "name": "Recipes",
        "keywords": {
            "recipe": 2,
            "ingredients": 2,
            "cook": 2,
            "bake": 2,
            "dish": 2,
            "flour": 2,
            "oven": 2,
            "sauce": 2,
            "kitchen": 1,
            "meal": 1,
        },
        "exemplars": [
            "pasta recipe with fresh ingredients",
            "baking a chocolate cake",
            "cooking dinner with the new sauce",
            "ingredients for tonight's meal",
            "homemade bread and soup recipe",
        ],
    },
    {
        "name": "Health",
        "keywords": {
            "doctor": 2,
            "health": 2,
            "medicine": 2,
            "symptom": 2,
            "workout": 2,
            "exercise": 2,
            "gym": 2,
            "diet": 2,
            "therapy": 2,
            "checkup": 2,
            "hospital": 2,
            "sleep": 1,
            "pain": 1,
        },
        "exemplars": [
            "doctor appointment and symptoms",
            "workout and exercise routine",
            "meal plan and diet goals",
            "health checkup results",
            "walking every morning for fitness",
        ],
    },
    {
        "name": "Tech",
        "keywords": {
            "code": 2,
            "software": 2,
            "server": 2,
            "bug": 2,
            "api": 2,
            "database": 2,
            "deploy": 2,
            "docker": 2,
            "script": 2,
            "config": 2,
            "tech": 1,
            "computer": 1,
        },
        "exemplars": [
            "writing code and fixing the bug",
            "deploying the server configuration",
            "api and database design",
            "software project notes",
            "learning about containers and deployment",
        ],
    },
    {
        "name": "Shopping",
        "keywords": {
            "shopping": 2,
            "store": 2,
            "groceries": 2,
            "grocery": 2,
            "cart": 2,
            "purchase": 2,
            "sale": 2,
            "checkout": 2,
            "milk": 2,
            "eggs": 2,
            "bread": 2,
            "butter": 2,
            "cheese": 2,
            "produce": 2,
            "veggies": 2,
            "buy": 1,
            "order": 1,
            "price": 1,
        },
        "exemplars": [
            "grocery shopping list",
            "pick up milk and bread",
            "buying fresh vegetables at the store",
            "shopping for the sale",
            "price comparison at the store",
            "things to order online",
        ],
    },
    {
        "name": "Home",
        "keywords": {
            "house": 2,
            "apartment": 2,
            "rent": 2,
            "garden": 2,
            "furniture": 2,
            "renovation": 2,
            "landlord": 2,
            "cleaning": 1,
            "repair": 1,
        },
        "exemplars": [
            "apartment rent and landlord notes",
            "home renovation plans",
            "garden and cleaning tasks",
            "furniture for the new house",
            "fixing the leaking tap at home",
        ],
    },
    {
        "name": "Car",
        "keywords": {
            "car": 2,
            "tires": 2,
            "brakes": 2,
            "engine": 2,
            "fuel": 2,
            "oil": 2,
            "garage": 2,
            "mechanic": 2,
            "vehicle": 2,
            "wash": 1,
            "driving": 1,
            "parking": 1,
        },
        "exemplars": [
            "new tires needed on the car",
            "brakes squeaking, book a mechanic",
            "wash the car this weekend",
            "oil change and fuel fill up",
            "car service at the garage",
        ],
    },
    {
        "name": "Study",
        "keywords": {
            "study": 2,
            "course": 2,
            "learn": 2,
            "lecture": 2,
            "exam": 2,
            "homework": 2,
            "lesson": 2,
            "school": 2,
            "university": 2,
            "understanding": 1,
            "class": 1,
        },
        "exemplars": [
            "study notes for the exam",
            "course lectures and homework",
            "learning python online",
            "school assignment timeline",
            "university lecture highlights",
        ],
    },
    {
        "name": "Diary",
        "keywords": {
            "diary": 2,
            "journal": 2,
            "mood": 2,
            "reflect": 2,
            "feeling": 1,
            "today": 1,
            "day": 1,
        },
        "exemplars": [
            "today was a long day at work",
            "journal entry about how I feel",
            "reflecting on the past week",
            "my mood and thoughts this morning",
        ],
    },
    {
        "name": "Books",
        "keywords": {
            "book": 2,
            "reading": 2,
            "author": 2,
            "novel": 2,
            "chapter": 2,
            "library": 2,
            "story": 1,
            "fiction": 2,
            "recommend": 1,
        },
        "exemplars": [
            "book review and reading list",
            "favorite novel chapters",
            "author biography and context",
            "books to read this summer",
            "notes on the latest fiction I read",
        ],
    },
]

# ---------------------------------------------------------------------------
# Embedding machinery (lazy; first /autotag call downloads ~90MB into /models)
# ---------------------------------------------------------------------------

_embed: tuple | None = None
_centroids: dict[str, np.ndarray] = {}


def _load_embed():
    global _embed
    if _embed is None:
        from transformers import AutoModel, AutoTokenizer

        log.info("Loading %s (first run downloads weights into %s)", EMBED_MODEL_ID, os.environ["HF_HOME"])
        tokenizer = AutoTokenizer.from_pretrained(EMBED_MODEL_ID)
        model = AutoModel.from_pretrained(EMBED_MODEL_ID)
        model.eval()
        _embed = (tokenizer, model)
        _build_centroids()
        log.info("Auto-tag classifier ready (%d tags)", len(_centroids))
    return _embed


def _build_centroids() -> None:
    """Centroid = mean of a tag's exemplars, re-normalized (cosine space)."""
    global _centroids
    texts = [ex for tag in TAGS for ex in tag["exemplars"]]
    vecs = _encode_np(texts)
    _centroids = {}
    idx = 0
    for tag in TAGS:
        n = len(tag["exemplars"])
        block = vecs[idx : idx + n]
        idx += n
        centroid = block.mean(axis=0)
        norm = float(np.linalg.norm(centroid)) or 1.0
        _centroids[tag["name"]] = centroid / norm


def _encode_np(texts: list[str]) -> np.ndarray:
    """Mean-pooled, L2-normalized sentence embeddings. (n, 384)."""
    tokenizer, model = _load_embed()
    import torch

    cleaned = [t for t in texts]
    inputs = tokenizer(
        cleaned,
        padding=True,
        truncation=True,
        max_length=256,
        return_tensors="pt",
    )
    with torch.no_grad():
        out = model(**inputs).last_hidden_state
        mask = inputs["attention_mask"].unsqueeze(-1)
        summed = (out * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1)
        vecs = summed / counts
    vecs = vecs / vecs.norm(dim=1, keepdim=True).clamp(min=1e-9)
    return vecs.cpu().numpy()


def _keyword_scores(text: str) -> dict[str, float]:
    lowered = text.lower()
    scores: dict[str, float] = {}
    for tag in TAGS:
        total = sum(w for k, w in tag["keywords"].items() if k in lowered)
        if total > 0:
            scores[tag["name"]] = total
    return scores


# ---------------------------------------------------------------------------
# Public classification API
# ---------------------------------------------------------------------------

def classify(text: str) -> list[dict]:
    """Return [{tag, score, method}, ...] for one note, capped and thresholded."""
    text = (text or "").strip()
    if not text:
        return []

    # Option A: deterministic keyword override when a single tag dominates.
    kw = _keyword_scores(text)
    if kw:
        ranked = sorted(kw.items(), key=lambda kv: (-kv[1], -len(kv[0])))
        best, best_score = ranked[0]
        second = ranked[1][1] if len(ranked) > 1 else 0.0
        if best_score >= KEYWORD_MIN and best_score - second >= 1.0:
            return [{"tag": best, "score": round(min(best_score / 4.0, 1.0), 3), "method": "keyword"}]

    # Option B: embedding similarity against tag centroids.
    vec = _encode_np([text])[0]
    sims = [(tag, float(np.dot(vec, centroid))) for tag, centroid in _centroids.items()]
    sims.sort(key=lambda st: -st[1])
    results = []
    for tag, score in sims:
        if score < VECTOR_MIN or len(results) >= VECTOR_TOPK:
            continue
        results.append({"tag": tag, "score": round(score, 3), "method": "vector"})
    return results


def classify_many(texts: list[str]) -> list[list[dict]]:
    """Classify a batch of notes in one embedding pass (vector + keyword mix).

    Each item is fully independent so one bad entry never affects the rest.
    """
    batch_src: list[str | None] = [(t or "").strip() or None for t in texts]

    vectors: dict[int, np.ndarray] = {}
    to_encode = [i for i, t in enumerate(batch_src) if t is not None]
    if to_encode:
        # Force model load + centroid build once up front.
        _load_embed()
        vecs = _encode_np([batch_src[i] for i in to_encode])
        for i, vec in zip(to_encode, vecs):
            vectors[i] = vec

    out: list[list[dict]] = []
    for i, text in enumerate(batch_src):
        if text is None:
            out.append([])
            continue

        kw = _keyword_scores(text)
        kw_result: list[dict] = []
        if kw:
            ranked = sorted(kw.items(), key=lambda kv: (-kv[1], -len(kv[0])))
            best, best_score = ranked[0]
            second = ranked[1][1] if len(ranked) > 1 else 0.0
            if best_score >= KEYWORD_MIN and best_score - second >= 1.0:
                kw_result = [{"tag": best, "score": round(min(best_score / 4.0, 1.0), 3), "method": "keyword"}]

        results: list[dict] = list(kw_result)
        if not results:
            vec = vectors.get(i)
            if vec is not None:
                sims = [(tag, float(np.dot(vec, centroid))) for tag, centroid in _centroids.items()]
                sims.sort(key=lambda st: -st[1])
                for tag, score in sims:
                    if score < VECTOR_MIN or len(results) >= VECTOR_TOPK:
                        continue
                    results.append({"tag": tag, "score": round(score, 3), "method": "vector"})
        out.append(results)
    return out