/**
 * The example widget that development builds add to the widgets folder. It adds an empty page,
 * titled with the widget's name.
 * Tutorial: https://toolblox.dev/docs/widgets/tutorials/first-widget/
 */
export function activate(toolblox) {
  toolblox.registerPage(function HelloPage() {
    return null;
  });
}

export function deactivate() {}
