const React = require("react");
const { View } = require("react-native");

function useVideoPlayer(source) {
  return { source };
}

function VideoView(props) {
  return React.createElement(View, { ...props, testID: "video-view" });
}

module.exports = { useVideoPlayer, VideoView };
