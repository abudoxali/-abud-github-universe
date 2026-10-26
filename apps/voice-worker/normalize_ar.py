"""Egyptian Arabic text normalization for TTS synthesis.

Converts numbers, dates, times, currency, percentages, agent/company names,
and common technical terms to natural Egyptian colloquial pronunciation.
Strips markdown, URLs, and emoji.
"""
import re

MONTHS_AR = {
    1: 'يناير',
    2: 'فبراير',
    3: 'مارس',
    4: 'أبريل',
    5: 'مايو',
    6: 'يونيو',
    7: 'يوليو',
    8: 'أغسطس',
    9: 'سبتمبر',
    10: 'أكتوبر',
    11: 'نوفمبر',
    12: 'ديسمبر',
}

ONES_EGY = {
    0: 'صفر',
    1: 'واحد',
    2: 'اتنين',
    3: 'تلاتة',
    4: 'أربعة',
    5: 'خمسة',
    6: 'ستة',
    7: 'سبعة',
    8: 'تمانية',
    9: 'تسعة',
    10: 'عشرة',
    11: 'حداشر',
    12: 'اتناشر',
    13: 'تلاتاشر',
    14: 'أربعتاشر',
    15: 'خمستاشر',
    16: 'ستتاشر',
    17: 'سبعتاشر',
    18: 'تمنتاشر',
    19: 'تسعتاشر',
}

TENS_EGY = {
    20: 'عشرين',
    30: 'تلاتين',
    40: 'أربعين',
    50: 'خمسين',
    60: 'ستين',
    70: 'سبعين',
    80: 'تمانين',
    90: 'تسعين',
}

HUNDREDS_EGY = {
    100: 'مية',
    200: 'ميتين',
    300: 'تلتمية',
    400: 'ربعمية',
    500: 'خمسمية',
    600: 'ستمية',
    700: 'سبعمية',
    800: 'تمنمية',
    900: 'تسعمية',
}

NAME_MAP = [
    (re.compile(r'\bABUD\s+FUN\b', re.IGNORECASE), 'عبود فن'),
    (re.compile(r'\bOmniRoute\b', re.IGNORECASE), 'أومني راوت'),
    (re.compile(r'\bCompany\s+OS\b', re.IGNORECASE), 'كومباني أو إس'),
    (re.compile(r'\bORI\b', re.IGNORECASE), 'أوري'),
    (re.compile(r'\bMIA\b', re.IGNORECASE), 'ميا'),
    (re.compile(r'\bNEX\b', re.IGNORECASE), 'نِكس'),
    (re.compile(r'\bLUNA\b', re.IGNORECASE), 'لونا'),
    (re.compile(r'\bZEN\b', re.IGNORECASE), 'زِن'),
    (re.compile(r'\bREX\b', re.IGNORECASE), 'ريكس'),
]

TECH_TERMS = [
    (re.compile(r'\bAPIs?\b', re.IGNORECASE), 'إيه بي آي'),
    (re.compile(r'\bUI\b', re.IGNORECASE), 'يو آي'),
    (re.compile(r'\bUX\b', re.IGNORECASE), 'يو إكس'),
    (re.compile(r'\bAI\b', re.IGNORECASE), 'إيه آي'),
    (re.compile(r'\bOS\b', re.IGNORECASE), 'أو إس'),
    (re.compile(r'\bDB\b', re.IGNORECASE), 'دي بي'),
    (re.compile(r'\bPRs?\b', re.IGNORECASE), 'بي آر'),
    (re.compile(r'\bSTT\b', re.IGNORECASE), 'إس تي تي'),
    (re.compile(r'\bTTS\b', re.IGNORECASE), 'تي تي إس'),
    (re.compile(r'\bASR\b', re.IGNORECASE), 'إيه إس آر'),
    (re.compile(r'\bGPUs?\b', re.IGNORECASE), 'جي بي يو'),
    (re.compile(r'\bCPUs?\b', re.IGNORECASE), 'سي بي يو'),
    (re.compile(r'\bVRAM\b', re.IGNORECASE), 'في رام'),
    (re.compile(r'\bRAM\b', re.IGNORECASE), 'رام'),
    (re.compile(r'\bRTF\b', re.IGNORECASE), 'آر تي إف'),
    (re.compile(r'\b(G[iI]?B|gigabytes?)\b', re.IGNORECASE), 'جيجا'),
    (re.compile(r'\b(M[iI]?B|megabytes?)\b', re.IGNORECASE), 'ميجا'),
    (re.compile(r'\b(K[iI]?B|kilobytes?)\b', re.IGNORECASE), 'كيلو'),
    (re.compile(r'\bms\b', re.IGNORECASE), 'ميلي ثانية'),
    (re.compile(r'\bsec(?:onds?)?\b', re.IGNORECASE), 'ثواني'),
    (re.compile(r'\bEGP\b', re.IGNORECASE), 'جنيه'),
    (re.compile(r'\bLE\b', re.IGNORECASE), 'جنيه'),
    (re.compile(r'\bbugs?\b', re.IGNORECASE), 'بَج'),
    (re.compile(r'\bcode\b', re.IGNORECASE), 'كود'),
    (re.compile(r'\bcommits?\b', re.IGNORECASE), 'كوميت'),
    (re.compile(r'\bbranch(?:es)?\b', re.IGNORECASE), 'برانش'),
    (re.compile(r'\btests?\b', re.IGNORECASE), 'تيست'),
    (re.compile(r'\bchecks?\b', re.IGNORECASE), 'تشيك'),
    (re.compile(r'\btasks?\b', re.IGNORECASE), 'تاسك'),
    (re.compile(r'\bbridge\b', re.IGNORECASE), 'بريدج'),
    (re.compile(r'\bworkers?\b', re.IGNORECASE), 'وركر'),
    (re.compile(r'\bbackend\b', re.IGNORECASE), 'باك إند'),
    (re.compile(r'\bfrontend\b', re.IGNORECASE), 'فرونت إند'),
    (re.compile(r'\bapps?\b', re.IGNORECASE), 'أب'),
    (re.compile(r'\bservers?\b', re.IGNORECASE), 'سيرفر'),
    (re.compile(r'\bclients?\b', re.IGNORECASE), 'كلاينت'),
    (re.compile(r'\btokens?\b', re.IGNORECASE), 'توكن'),
    (re.compile(r'\bchats?\b', re.IGNORECASE), 'شات'),
    (re.compile(r'\bcache\b', re.IGNORECASE), 'كاش'),
    (re.compile(r'\bcloud\b', re.IGNORECASE), 'كلاود'),
    (re.compile(r'\bdeploy(?:ment)?\b', re.IGNORECASE), 'ديبلاي'),
    (re.compile(r'\bdashboards?\b', re.IGNORECASE), 'داشبورد'),
    (re.compile(r'\blogs?\b', re.IGNORECASE), 'لوج'),
    (re.compile(r'\bonline\b', re.IGNORECASE), 'أونلاين'),
    (re.compile(r'\boffline\b', re.IGNORECASE), 'أوفلاين'),
    (re.compile(r'\bsystems?\b', re.IGNORECASE), 'سيستم'),
    (re.compile(r'\bstatus\b', re.IGNORECASE), 'ستاتس'),
    (re.compile(r'\bversions?\b', re.IGNORECASE), 'فيرجن'),
    (re.compile(r'\bdata\b', re.IGNORECASE), 'داتا'),
    (re.compile(r'\bmodels?\b', re.IGNORECASE), 'موديل'),
    (re.compile(r'\busers?\b', re.IGNORECASE), 'يوزر'),
    (re.compile(r'\bprojects?\b', re.IGNORECASE), 'بروجكت'),
    (re.compile(r'\bdatabase\b', re.IGNORECASE), 'داتابيز'),
    (re.compile(r'\bscripts?\b', re.IGNORECASE), 'سكريبت'),
]


def int_to_egyptian_words(n: int) -> str:
    """Converts an integer (0 to 999,999,999) into Egyptian Arabic words."""
    if n < 0:
        return 'سالب ' + int_to_egyptian_words(-n)
    if n <= 19:
        return ONES_EGY[n]
    if n < 100:
        tens_val = (n // 10) * 10
        ones_val = n % 10
        if ones_val == 0:
            return TENS_EGY[tens_val]
        return f'{ONES_EGY[ones_val]} و{TENS_EGY[tens_val]}'
    if n < 1000:
        hundreds_val = (n // 100) * 100
        remainder = n % 100
        h_str = HUNDREDS_EGY[hundreds_val]
        if remainder == 0:
            return h_str
        return f'{h_str} و{int_to_egyptian_words(remainder)}'
    if n < 1000000:
        thousands = n // 1000
        remainder = n % 1000
        if thousands == 1:
            th_str = 'ألف'
        elif thousands == 2:
            th_str = 'ألفين'
        elif 3 <= thousands <= 10:
            th_str = f'{ONES_EGY[thousands]} آلاف'
        else:
            th_str = f'{int_to_egyptian_words(thousands)} ألف'
        if remainder == 0:
            return th_str
        return f'{th_str} و{int_to_egyptian_words(remainder)}'
    if n < 1000000000:
        millions = n // 1000000
        remainder = n % 1000000
        if millions == 1:
            m_str = 'مليون'
        elif millions == 2:
            m_str = 'مليونين'
        elif 3 <= millions <= 10:
            m_str = f'{ONES_EGY[millions]} مليون'
        else:
            m_str = f'{int_to_egyptian_words(millions)} مليون'
        if remainder == 0:
            return m_str
        return f'{m_str} و{int_to_egyptian_words(remainder)}'
    return str(n)


def float_to_egyptian_words(num_str: str) -> str:
    """Converts a string representation of an integer or decimal to Egyptian words."""
    if '.' in num_str:
        integer_part, frac_part = num_str.split('.', 1)
        int_val = int(integer_part) if integer_part else 0
        int_words = int_to_egyptian_words(int_val)
        if frac_part == '5' or frac_part == '50':
            return f'{int_words} ونص'
        if frac_part == '25':
            return f'{int_words} وربع'
        if frac_part == '75':
            return f'{int_words} وتلات تربع'
        frac_words = ' '.join(ONES_EGY.get(int(digit), digit) for digit in frac_part)
        return f'{int_words} فاصلة {frac_words}'
    return int_to_egyptian_words(int(num_str))


def _replace_percentages(text: str) -> str:
    def repl(match):
        num = match.group(1)
        words = float_to_egyptian_words(num)
        return f'{words} في المية'
    return re.sub(r'(\d+(?:\.\d+)?)\s*%', repl, text)


def _replace_times(text: str) -> str:
    def repl(match):
        hour = int(match.group(1))
        minute = int(match.group(2))
        period = match.group(3) or ''
        hour_word = ONES_EGY.get(hour, str(hour))
        if minute == 0:
            res = hour_word
        elif minute == 15:
            res = f'{hour_word} وربع'
        elif minute == 20:
            res = f'{hour_word} وتلت'
        elif minute == 30:
            res = f'{hour_word} ونص'
        elif minute == 40:
            next_hour = (hour % 12) + 1
            res = f'{ONES_EGY.get(next_hour, str(next_hour))} إلا تلت'
        elif minute == 45:
            next_hour = (hour % 12) + 1
            res = f'{ONES_EGY.get(next_hour, str(next_hour))} إلا ربع'
        else:
            res = f'{hour_word} و{int_to_egyptian_words(minute)} دقيقة'
        period_lower = period.lower().strip()
        if period_lower in ('am', 'ص', 'صباحاً'):
            res += ' الصبح'
        elif period_lower in ('pm', 'م', 'مساءً'):
            res += ' بالليل'
        return res
    pattern = r'\b(\d{1,2}):(\d{2})(?:\s*(am|pm|ص|م|صباحاً|مساءً))?\b'
    return re.sub(pattern, repl, text, flags=re.IGNORECASE)


def _replace_dates(text: str) -> str:
    def repl_iso(match):
        year = int(match.group(1))
        month = int(match.group(2))
        day = int(match.group(3))
        day_words = int_to_egyptian_words(day)
        month_name = MONTHS_AR.get(month, str(month))
        year_words = int_to_egyptian_words(year)
        return f'{day_words} {month_name} {year_words}'

    def repl_dmy(match):
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3))
        day_words = int_to_egyptian_words(day)
        month_name = MONTHS_AR.get(month, str(month))
        year_words = int_to_egyptian_words(year)
        return f'{day_words} {month_name} {year_words}'

    text = re.sub(r'\b(19\d\d|20\d\d)[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b', repl_iso, text)
    text = re.sub(r'\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](19\d\d|20\d\d)\b', repl_dmy, text)
    return text


def _replace_numbers(text: str) -> str:
    # Convert Eastern Arabic numerals (٠-٩) to standard digits (0-9)
    eastern = '٠١٢٣٤٥٦٧٨٩'
    for idx, char in enumerate(eastern):
        text = text.replace(char, str(idx))

    def repl(match):
        num_str = match.group(0)
        return float_to_egyptian_words(num_str)

    return re.sub(r'\b\d+(?:\.\d+)?\b', repl, text)


def _strip_markdown_and_links(text: str) -> str:
    # Remove code blocks
    text = re.sub(r'```[\s\S]*?```', '', text)
    # Inline code
    text = re.sub(r'`([^`]+)`', r'\1', text)
    # Markdown links: [anchor](url) -> anchor (run before URL stripping)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    # URLs
    text = re.sub(r'https?://\S+|www\.\S+', '', text)
    # Headers
    text = re.sub(r'^\s*#{1,6}\s*', '', text, flags=re.MULTILINE)
    # Bold / Italic
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'\*([^*]+)\*', r'\1', text)
    text = re.sub(r'__([^_]+)__', r'\1', text)
    text = re.sub(r'_([^_]+)_', r'\1', text)
    # Blockquotes / lists
    text = re.sub(r'^\s*>\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*[\*\-\+]\s+', '', text, flags=re.MULTILINE)
    # HTML tags
    text = re.sub(r'<[^>]+>', '', text)
    return text


def _strip_emoji_and_noise(text: str) -> str:
    # Remove tatweel (kashida)
    text = text.replace('ـ', '')
    # Remove emojis and miscellaneous symbols
    emoji_pattern = re.compile(
        '['
        '\U00010000-\U0010ffff'
        '☀-➿'
        '⌀-⏿'
        '⭐-⭕'
        '‍'
        '️'
        ']+',
        flags=re.UNICODE
    )
    text = emoji_pattern.sub('', text)
    # Normalize excessive punctuation (keep single Arabic/Latin question mark, exclamation, or period)
    text = re.sub(r'[!！]{2,}', '!', text)
    text = re.sub(r'[\?؟]{2,}', '؟', text)
    text = re.sub(r'\.{2,}', '...', text)
    # Collapse multiple spaces
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def normalize_egyptian_arabic(text: str) -> str:
    """Complete normalization pipeline for Egyptian colloquial TTS."""
    if not text:
        return ''

    # 1. Strip markdown, links, URLs
    text = _strip_markdown_and_links(text)

    # 2. Company and Agent Names
    for pattern, replacement in NAME_MAP:
        text = pattern.sub(replacement, text)

    # 3. Common technical terms transliterated
    for pattern, replacement in TECH_TERMS:
        text = pattern.sub(replacement, text)

    # 4. Dates and Times
    text = _replace_dates(text)
    text = _replace_times(text)

    # 5. Percentages
    text = _replace_percentages(text)

    # 6. Standalone numbers
    text = _replace_numbers(text)

    # 7. Strip emoji, cleanup spaces and punctuation
    text = _strip_emoji_and_noise(text)

    return text
