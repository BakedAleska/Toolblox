"""The app's own version.

Kept manually in sync with `MyAppVersion` in installer/Toolblox.nsi for
each release. native/launcher's Toolblox.exe (the auto-updater) and
toolblox.updater's manual "Check for Updates" both compare this against
GitHub's latest release tag to decide whether an update is available.
"""

from toolblox.devtools import release_channel

APP_VERSION = "0.1.8.2-beta"


def display_version() -> str:
    """APP_VERSION's number with the *actual* running channel appended.

    APP_VERSION's own "-beta" suffix reflects the last packaged release
    and is what toolblox.updater and release/build.py key off of - it
    shouldn't change based on how the app happens to be running right
    now. This instead pairs the same number with
    toolblox.devtools.release_channel(), so a source checkout reads
    "-canary" here even though APP_VERSION itself still says "-beta".
    """
    number = APP_VERSION.split("-")[0]
    return f"{number}-{release_channel()}"
