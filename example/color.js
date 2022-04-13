const path = require("path");
const fs = require("fs");
const { generateTheme, getLessVars } = require("../index.js");

const themeVariables = getLessVars(path.join(__dirname, "./theme/vars.less"));
const defaultVars = getLessVars(
  "./node_modules/antd/lib/style/themes/default.less"
);
const darkVars = {
  ...getLessVars("./node_modules/antd/lib/style/themes/dark.less"),
  "@primary-color": defaultVars["@primary-color"],
};

fs.writeFileSync("./public/dark.json", JSON.stringify(darkVars));
fs.writeFileSync("./public/light.json", JSON.stringify(defaultVars));

const options = {
  stylesDir: path.join(__dirname, "./theme"),
  antDir: path.join(__dirname, "./node_modules/antd"),
  varFile: path.join(__dirname, "./theme/vars.less"),
  themeVariables: Array.from(
    new Set([
      ...Object.keys(darkVars),
      ...Object.keys(defaultVars),
      ...Object.keys(themeVariables),
    ])
  ),
  outputFilePath: path.join(__dirname, "./public/color.less"),
};

generateTheme(options)
  .then((less) => {
    console.log("Theme generated successfully");
  })
  .catch((error) => {
    console.log("Error", error);
  });
