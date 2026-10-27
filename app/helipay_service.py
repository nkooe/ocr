from __future__ import annotations

from dataclasses import dataclass
import re

from app.math_service import ExpressionError, evaluate_expression


@dataclass(frozen=True)
class HelipayResult:
    result: str
    answer: str


_DIGITS = {
    "a": "0",
    "A": "4",
    "D": "0",
    "s": "5",
    "S": "5",
    "g": "9",
    "G": "9",
    "q": "9",
    "Q": "9",
    "o": "0",
    "O": "0",
    "l": "1",
    "I": "1",
    "L": "1",
    "|": "1",
    "T": "7",
    "t": "7",
    "Y": "1",
    "y": "1",
    "ス": "5",
    "の": "6",
    "ロ": "0",
    "口": "0",
}
_OPS = {
    "+": "+",
    "＋": "+",
    "-": "-",
    "−": "-",
    "－": "-",
    ".": "-",
    "。": "-",
    "·": "-",
    "∙": "-",
    "~": "-",
    "*": "*",
    "×": "*",
    "✕": "*",
    "＊": "*",
    "x": "*",
    "X": "*",
    "÷": "/",
    "／": "/",
    "/": "/",
    # Helipay 的细斜杠偶尔会被 OCR 识别成 1；这里只在运算符位置生效。
    "1": "/",
    "I": "/",
    "l": "/",
    "|": "/",
}
_CHAR = r"0-9a-zA-Z|のスロ口"
_EXPRESSION = re.compile(
    rf"(?P<left>[{_CHAR}])"
    rf"(?P<op>[{re.escape(''.join(_OPS))}])"
    rf"(?P<right>[{_CHAR}])"
)
_TAIL_MARKERS = frozenset("=≈≃≅~?？元!！")
_FULLWIDTH = str.maketrans(
    {
        "０": "0",
        "１": "1",
        "２": "2",
        "３": "3",
        "４": "4",
        "５": "5",
        "６": "6",
        "７": "7",
        "８": "8",
        "９": "9",
        "＋": "+",
        "－": "-",
        "×": "*",
        "✕": "*",
        "＊": "*",
        "÷": "/",
        "／": "/",
    }
)


def parse_helipay_text(raw_text: str) -> HelipayResult | None:
    text = re.sub(r"\s+", "", raw_text.translate(_FULLWIDTH))
    if not text:
        return None

    return _parse_pattern(text, _EXPRESSION)


def _parse_pattern(
    text: str,
    pattern: re.Pattern[str],
) -> HelipayResult | None:
    for match in pattern.finditer(text):
        if _has_prefix_noise(text[: match.start()]):
            continue

        left = _digit(match.group("left"))
        right = _digit(match.group("right"))
        operator = _OPS.get(match.group("op"))
        if left is None or right is None or operator is None:
            continue
        if _has_tail_noise(text[match.end() :]):
            continue

        expression = f"{left}{operator}{right}"
        try:
            _, value = evaluate_expression(expression)
        except ExpressionError:
            continue
        return HelipayResult(result=f"{expression}=?", answer=str(value))
    return None


def _digit(value: str) -> str | None:
    if value.isdigit() and len(value) == 1:
        return value
    return _DIGITS.get(value)


def _has_prefix_noise(value: str) -> bool:
    return bool(value) and any(character not in _TAIL_MARKERS for character in value)


def _has_tail_noise(value: str) -> bool:
    return bool(value) and value[0] not in _TAIL_MARKERS
