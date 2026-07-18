/* Jest stand-in for react-native-webview: the native RNCWebViewModule does
   not exist in the jest-expo environment, and the component tree only needs
   the import to resolve (MermaidBlock renders the WebView inside a Modal
   that tests never open). */
module.exports = { WebView: () => null };
