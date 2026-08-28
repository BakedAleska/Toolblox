Toolblox
=========

Documentation generated from the docstrings in the `toolblox` package.

Guide
-----

The sections below group modules by what they do. Start here. The full,
alphabetical module tree is further down for reference.

Settings and app state
~~~~~~~~~~~~~~~~~~~~~~

Where user preferences and per-page state live.

* :doc:`api/toolblox.state`: read and write app settings for the current page.
* :doc:`api/toolblox.data.settings`: persistence for app settings, as a plain JSON dict.

Accounts
~~~~~~~~

Storing and managing the tracked Roblox account list.

* :doc:`api/toolblox.data.accounts`: persistence for the tracked Roblox account list.
* :doc:`api/toolblox.data.crypto`: per-platform protection for sensitive values stored in accounts.json.
* :doc:`api/toolblox.ui.accounts`: the Accounts screen. List, add, remove, join, and reorder tracked accounts.

Roblox login and join
~~~~~~~~~~~~~~~~~~~~~~

Logging into Roblox and launching into a place.

* :doc:`api/toolblox.roblox.login`: standalone Roblox login window, run as a subprocess.
* :doc:`api/toolblox.roblox.join`: build a launch URL for joining a Roblox place with a saved account.
* :doc:`api/toolblox.roblox.multi_instance`: Windows-only bypass for Roblox's singleton-instance check.
* :doc:`api/toolblox.ui.join_action`: shared join flow, used by both the Accounts screen and the Dashboard.

Widget plugin system
~~~~~~~~~~~~~~~~~~~~~

How third-party widgets are discovered, installed, and run.

* :doc:`api/toolblox.widgets.api`: the contract a widget must implement, and shared helpers for it.
* :doc:`api/toolblox.widgets.loader`: discover and import installed widgets from WIDGETS_DIR.
* :doc:`api/toolblox.widgets.catalog`: fetch and cache the Catalogue, the list of widgets available to install.
* :doc:`api/toolblox.widgets.installer`: download, verify, and install a widget from the Catalogue.
* :doc:`api/toolblox.widgets.process`: helper for widgets whose actual logic runs as an external process.
* :doc:`api/toolblox.ui.widgets`: the Widgets screen. The Catalogue banner and the grid of installed widgets.

App shell and other screens
~~~~~~~~~~~~~~~~~~~~~~~~~~~~

The rest of the UI and shared app infrastructure.

* :doc:`api/toolblox.app`: Toolblox's entrypoint. Window setup and the top-level view router.
* :doc:`api/toolblox.ui.layout`: the shared page shell. Nav rail plus content area, used by every view.
* :doc:`api/toolblox.ui.dashboard`: the Dashboard. A Roblox-style continue card, an account row, and stats.
* :doc:`api/toolblox.ui.settings`: the Settings screen.
* :doc:`api/toolblox.ui.style`: shared visual constants and helpers.
* :doc:`api/toolblox.ui.toast`: snackbar-based toast notifications, shared across all views.
* :doc:`api/toolblox.config`: per-OS data directory and shared URLs.
* :doc:`api/toolblox.logs`: file-based logging shared by every part of the app.

.. toctree::
   :maxdepth: 2
   :hidden:

   core
   data
   roblox
   ui
   widgets
