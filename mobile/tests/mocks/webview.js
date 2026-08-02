/* Jest stand-in for react-native-webview: the native RNCWebViewModule does
   not exist in the jest-expo environment, and the component tree only needs
   the import to resolve (MermaidBlock renders the WebView inside a Modal
   that tests never open). */
const React = require("react");

const WebView = React.forwardRef((_props, ref) => {
  React.useImperativeHandle(ref, () => ({
    injectJavaScript(script) {
      WebView.injected.push(script);
    },
  }));
  return null;
});
WebView.injected = [];

module.exports = { WebView };
