import os


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", os.urandom(32).hex())

    # Instagram API
    IG_BASE_URL = "https://i.instagram.com/api/v1"
    IG_MOBILE_USER_AGENT = (
        "Instagram 317.0.0.34.109 Android (30/11; 420dpi; 1080x2220; "
        "samsung; SM-A515F; a51; exynos9611; en_US; 562800748)"
    )
    IG_APP_ID = "936619743392459"

    # Rate limiting
    CANCEL_DELAY_MIN = 5
    CANCEL_DELAY_MAX = 10
    FETCH_PAGE_DELAY = 1
    MAX_CANCELS_PER_SESSION = 200

    # Flask session
    PERMANENT_SESSION_LIFETIME = 3600
    MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500 MB max upload
