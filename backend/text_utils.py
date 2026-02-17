"""
Shared text preprocessing for VCM: expand emotion-related emojis and keywords
into tokens so the Stage 1 model (TF-IDF + XGB) can use them as features.
Must be applied at training time and at inference time identically.
"""

# Emoji -> token that TF-IDF will see (0=neutral, 1=pleased, 2=funny, 3=fear, 4=sad)
EMOJI_TO_EMOTION_TOKEN = {
    "\U0001f602": " laughing_tears ",
    "\U0001f923": " rolling_laugh ",
    "\U0001f639": " cat_laugh ",
    "\U0001f61c": " funny_face ",
    "\U0001f604": " big_smile ",
    "\U0001f606": " laughing ",
    "\U0001f62d": " sobbing ",
    "\U0001f622": " crying ",
    "\U0001f494": " broken_heart ",
    "\U0001f97a": " sad_pleading ",
    "\U0001f625": " relieved_sad ",
    "\U0001f631": " scared ",
    "\U0001f628": " fear_face ",
    "\U0001f630": " cold_sweat ",
    "\U0001f635": " dizzy_face ",
    "\U0001f60a": " pleased_smile ",
    "\U0001f642": " slight_smile ",
    "\U0001f44d": " thumbs_up ",
    "\U0001f496": " heart_sparkle ",
    "\U0001f970": " smiling_hearts ",
    "\U0001f60d": " love_eyes ",
    "\U0001f389": " party ",
    "\U0001f610": " neutral_face ",
    "\U0001f612": " unamused ",
}

# Keyword (lowercase substring) -> token to add. Checked via "keyword in text_lower".
# Order: funny (2), sad (4), fear (3), pleased (1), neutral (0).
KEYWORD_TO_EMOTION_TOKEN = [
    # Funny
    ("lol", " funny_lol "), ("lmao", " funny_lmao "), ("lmfao", " funny_lmfao "),
    ("haha", " funny_haha "), ("hahaha", " funny_haha "), ("lolol", " funny_lol "),
    ("rofl", " funny_rofl "), ("roflmao", " funny_rofl "), ("hilarious", " funny_hilarious "),
    ("dying laughing", " funny_dying "), ("crack me up", " funny_crack "),
    ("so funny", " funny_so "), ("too funny", " funny_too "), ("xd", " funny_xd "),
    # Sad
    ("sad", " sad_word "), ("crying", " sad_crying "), ("cried", " sad_cried "),
    ("tears", " sad_tears "), ("rip", " sad_rip "), ("rest in peace", " sad_rip "),
    ("heartbreaking", " sad_heartbreak "), ("heartbroken", " sad_heartbreak "),
    ("so sad", " sad_so "), ("sobbing", " sad_sobbing "),
    # Fear
    ("scared", " fear_scared "), ("terrifying", " fear_terrifying "), ("nightmare", " fear_nightmare "),
    ("horrifying", " fear_horror "), ("creepy", " fear_creepy "), ("afraid", " fear_afraid "),
    # Pleased
    ("love this", " pleased_love "), ("amazing", " pleased_amazing "), ("best ever", " pleased_best "),
    ("awesome", " pleased_awesome "), ("great", " pleased_great "), ("perfect", " pleased_perfect "),
    ("beautiful", " pleased_beautiful "), ("wonderful", " pleased_wonderful "),
    ("recommend", " pleased_recommend "), ("masterpiece", " pleased_masterpiece "),
    ("love it", " pleased_love "),
    # Neutral (weaker signal)
    ("idk", " neutral_idk "), ("meh", " neutral_meh "), ("whatever", " neutral_whatever "),
]

# Compile once: for each (keyword, token) we'll check keyword in text_lower
def _keyword_tokens(text: str) -> list[str]:
    if not text:
        return []
    lower = text.lower()
    added = []
    for kw, token in KEYWORD_TO_EMOTION_TOKEN:
        if kw in lower:
            added.append(token.strip())
    return list(dict.fromkeys(added))  # preserve order, dedupe


def expand_emojis_for_emotion(text: str) -> str:
    """Append emotion tokens for emojis and keywords found in text so TF-IDF can use them.
    Keeps original text; appends space-separated tokens. Same logic at train and inference.
    """
    if not text:
        return text
    added = []
    for char in text:
        if char in EMOJI_TO_EMOTION_TOKEN:
            added.append(EMOJI_TO_EMOTION_TOKEN[char].strip())
    added.extend(_keyword_tokens(text))
    added = list(dict.fromkeys(added))  # dedupe
    if not added:
        return text
    return text + " " + " ".join(added)
