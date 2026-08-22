"""Toolblox's entrypoint: window setup and the top-level view router.

Run with ``python main.py`` at the repo root, or ``python -m toolblox.app``.
Views are plain functions, such as `toolblox.ui.dashboard.DashboardView`,
that take the `ft.Page` and return an `ft.View`. `route_change` below picks
which one to build for a route.
"""

import inspect
import sys

sys.dont_write_bytecode = True

import flet as ft  # noqa: E402

from toolblox import tray  # noqa: E402
from toolblox.logs import get_logger  # noqa: E402
from toolblox.state import (  # noqa: E402
    get_run_in_background,
    get_widget_start_on_launch,
    resolve_theme_mode,
)
from toolblox.ui.accounts import AccountsView  # noqa: E402
from toolblox.ui.dashboard import DashboardView  # noqa: E402
from toolblox.ui.layout import restore_nav_scroll  # noqa: E402
from toolblox.ui.settings import SettingsView  # noqa: E402
from toolblox.ui.style import app_theme  # noqa: E402
from toolblox.ui.widgets import WidgetsView  # noqa: E402
from toolblox.version import display_version  # noqa: E402
from toolblox.widgets.loader import get_enabled_widgets  # noqa: E402
from toolblox.widgets.process import stop_all_processes  # noqa: E402

logger = get_logger(__name__)


def main(page: ft.Page):
    """Configure the window and wire up routing for a new Flet session."""

    def handle_loop_exception(loop, context):
        """Log exceptions raised by `page.run_task`-scheduled background work.

        `page.run_task` surfaces a background task's exception by
        re-raising it inside a done-callback, which routes here rather
        than crashing anything visibly. Without this handler, a bug in a
        background task (e.g. a Catalogue refresh) fails completely
        silently.
        """
        exception = context.get("exception")
        message = context.get("message", "Unhandled error in a background task")
        logger.error(message, exc_info=exception)

    page.session.connection.loop.set_exception_handler(handle_loop_exception)

    def on_window_event(e: ft.WindowEvent):
        """Handle the window close request.

        With "Run in background" off, this stops any process a widget
        started (e.g. an autoclicker's click loop) so nothing is left
        running as an orphan once the window closes.

        With it on, `page.window.prevent_close` is already set below, so
        the close request lands here instead of actually closing the
        window: hide it and show a tray icon instead, so the app is still
        reachable from the hidden icons section (Windows) or menu bar
        (macOS) rather than fully quitting.
        """
        if e.type != ft.WindowEventType.CLOSE:
            return
        if get_run_in_background(page):
            page.window.visible = False
            page.window.skip_task_bar = True
            page.update()
            tray.show(page)
        else:
            stop_all_processes(page)

    page.window.on_event = on_window_event

    page.title = f"Toolblox-v{display_version()}"
    page.window.icon = "logo.svg"
    page.theme_mode = resolve_theme_mode(page)
    page.theme = app_theme()
    page.window.width = 900
    page.window.height = 500
    page.window.resizable = True
    page.window.prevent_close = get_run_in_background(page)
    page.padding = 0

    async def route_change(route):
        """Rebuild the view stack for the current route.

        Each navigation replaces the whole stack with one view, rather
        than pushing and popping. Falls back to the Dashboard if a view
        fails to build, so one broken route can't take down the app.

        Async so the nav scroll restore below can be awaited directly:
        `page.on_route_change` handlers are awaited in place by Flet's own
        event dispatch, which is a tighter path than scheduling a second
        `page.run_task` from inside a sync handler.
        """
        page.views.clear()

        try:
            if page.route == "/":
                page.views.append(DashboardView(page))
            elif page.route == "/accounts":
                page.views.append(AccountsView(page))
            elif page.route == "/widgets":
                page.views.append(WidgetsView(page))
            elif page.route == "/settings":
                page.views.append(SettingsView(page))
            elif page.route.startswith("/widgets/"):
                widget_id = page.route.removeprefix("/widgets/")
                widget = next((w for w in get_enabled_widgets(page) if w.id == widget_id), None)
                page.views.append(widget.build_view(page) if widget else DashboardView(page))
        except Exception:
            logger.exception("Failed to build view for route '%s'", page.route)
            page.views.clear()
            page.views.append(DashboardView(page))

        page.update()
        await restore_nav_scroll(page)

    def view_pop(view):
        """Handle a back-navigation: drop the top view and re-sync the route."""
        page.views.pop()
        top_view = page.views[-1]
        page.go(top_view.route)

    page.on_route_change = route_change
    page.on_view_pop = view_pop

    page.route = "/"
    page.run_task(route_change, page.route)

    async def run_widget_startup_hooks():
        """Run each enabled widget's on_app_start hook, if it opted in.

        A widget opts in via its own "Start on launch" toggle under
        Settings -> Widgets (see toolblox/widgets/api.py::Widget.on_app_start),
        not just by defining the hook - the hook itself only runs when
        that's turned on. One widget's hook failing is logged and
        skipped, not fatal to the rest.
        """
        for widget in get_enabled_widgets(page):
            if widget.on_app_start is None:
                continue
            if not get_widget_start_on_launch(page, widget.id):
                continue
            try:
                result = widget.on_app_start(page)
                if inspect.isawaitable(result):
                    await result
            except Exception:
                logger.exception("Widget '%s' failed to run its startup hook", widget.id)

    page.run_task(run_widget_startup_hooks)


def run():
    """Launch the Flet app."""
    ft.run(main, view=ft.AppView.FLET_APP)


if __name__ == "__main__":
    run()
