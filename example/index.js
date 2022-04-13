const fs = require("fs");
const path = require("path");
const glob = require("glob");
const postcss = require("postcss");
const less = require("less");
const hash = require("hash.js");
const bundle = require("less-bundle-promise");
const NpmImportPlugin = require("less-plugin-npm-import");
const stripCssComments = require("strip-css-comments");

let hashCache = "";
let cssCache = "";

// antd涉及的颜色函数
const COLOR_FUNCTIONS = [
  "color",
  "lighten",
  "darken",
  "saturate",
  "desaturate",
  "fadein",
  "fadeout",
  "fade",
  "spin",
  "mix",
  "hsv",
  "tint",
  "shade",
  "greyscale",
  "multiply",
  "contrast",
  "screen",
  "overlay",
];

// 转换为颜色函数的正则匹配：/color(.*)/,  /lighten(.*)/,
const defaultColorRegexArray = COLOR_FUNCTIONS.map(
  (name) => new RegExp(`${name}\(.*\)`)
);

defaultColorRegexArray.matches = (color) => {
  return defaultColorRegexArray.reduce((prev, regex) => {
    return prev || regex.test(color);
  }, false);
};

// 生成随机16进制颜色
function randomColor() {
  return (
    "#" + (0x1000000 + Math.random() * 0xffffff).toString(16).substring(1, 7)
  );
}

/*
  获取嵌套变量颜色
  
  如果一个样式是这样的：
  @primary-color: #1890ff;
  @link-color: @primary-color;

  @link-color -> @primary-color ->  #1890ff
  最后得到：
  @link-color: #1890ff
*/
function getColor(varName, mappings) {
  const color = mappings[varName];
  if (color in mappings) {
    return getColor(color, mappings);
  } else {
    return color;
  }
}

/*
  判断色值是否合法：

  isValidColor('#ffffff'); //true
  isValidColor('#fff'); //true
  isValidColor('rgba(0, 0, 0, 0.5)'); //true
  isValidColor('20px'); //false
*/
function isValidColor(color, customColorRegexArray = []) {
  if (color && color.includes("rgb")) return true;
  if (!color || color.match(/px/g)) return false;
  if (color.match(/colorPalette|fade/g)) return true;
  if (color.charAt(0) === "#") {
    color = color.substring(1);
    return (
      [3, 4, 6, 8].indexOf(color.length) > -1 && !isNaN(parseInt(color, 16))
    );
  }
  // eslint-disable-next-line
  const isColor =
    /^(rgb|hsl|hsv)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i.test(
      color
    );
  if (isColor) return true;
  if (customColorRegexArray.length > 0) {
    return customColorRegexArray.reduce((prev, regex) => {
      return prev || regex.test(color);
    }, false);
  }
  return false;
}

/*
  得到颜色对应的mapping键值对
  {
    '@primary-color': '#00375B',
    '@info-color': '#1890ff',
    '@success-color': '#52c41a',
    '@error-color': '#f5222d',
    '@normal-color': '#d9d9d9',
    '@primary-6': '#1890ff',
    '@heading-color': '#fa8c16',
    '@text-color': '#cccccc',
    ....
  }
*/
function generateColorMap(content, customColorRegexArray = []) {
  return content
    .split("\n")
    .filter((line) => line.startsWith("@") && line.indexOf(":") > -1)
    .reduce((prev, next) => {
      try {
        const matches = next.match(
          /(?=\S*['-])([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/
        );
        if (!matches) {
          return prev;
        }
        let [, varName, color] = matches;
        if (color && color.startsWith("@")) {
          color = getColor(color, prev);
          if (!isValidColor(color, customColorRegexArray)) return prev;
          prev[varName] = color;
        } else if (isValidColor(color, customColorRegexArray)) {
          prev[varName] = color;
        }
        return prev;
      } catch (e) {
        console.log("e", e);
        return prev;
      }
    }, {});
}

// 过滤只包含颜色的css属性
const reducePlugin = postcss.plugin("reducePlugin", () => {
  const cleanRule = (rule) => {
    if (rule.selector.startsWith(".main-color .palatte-")) {
      rule.remove();
      return;
    }

    let removeRule = true;
    rule.walkDecls((decl) => {
      let matched = false;
      if (String(decl.value).match(/url\(.*\)/g)) {
        decl.remove();
        matched = true;
      }
      // 删除不包含颜色的规则
      if (
        !decl.prop.includes("color") &&
        !decl.prop.includes("background") &&
        !decl.prop.includes("border") &&
        !decl.prop.includes("box-shadow") &&
        !decl.prop.includes("stroke") &&
        !decl.prop.includes("fill") &&
        !Number.isNaN(decl.value)
      ) {
        decl.remove();
      } else {
        removeRule = matched ? removeRule : false;
      }
    });
    if (removeRule) {
      rule.remove();
    }
  };

  return (css) => {
    css.walkAtRules((atRule) => {
      atRule.remove();
    });
    css.walkRules(cleanRule);
    // 删除所有注释
    css.walkComments((c) => c.remove());
  };
});

function getMatches(string, regex) {
  const matches = {};
  let match;
  while ((match = regex.exec(string))) {
    if (match[2].startsWith("rgba") || match[2].startsWith("#")) {
      matches[`@${match[1]}`] = match[2];
    }
  }
  return matches;
}

// 将less编译为css
function render(text, paths) {
  return less.render(text, {
    paths: paths,
    javascriptEnabled: true,
    plugins: [new NpmImportPlugin({ prefix: "~" })],
  });
}

function getLessVarsObj(content) {
  const lessVars = {};
  const matches = content.match(/@(.*:[^;]*)/g) || [];

  matches.forEach((variable) => {
    const definition = variable.split(/:\s*/);
    const varName = definition[0].replace(/['"]+/g, "").trim();
    lessVars[varName] = definition.splice(1).join(":");
  });
  return lessVars;
}

/*
  将less文件转换为对象
  {
    '@primary-color' : '#1890ff',
    '@heading-color' : '#fa8c16',
    '@text-color' : '#cccccc'
  }
*/
function getLessVars(filtPath) {
  const sheet = fs.readFileSync(filtPath).toString();
  let lessVars = {};
  lessVars = getLessVarsObj(sheet);
  return lessVars;
}

/*
  Input: @primary-1
  Output: color(~`colorPalette("@{primary-color}", ' 1 ')`)
*/
function getShade(varName) {
  let [, className, number] = varName.match(/(.*)-(\d)/);
  if (/primary-\d/.test(varName)) className = "@primary-color";
  return (
    'color(~`colorPalette("@{' +
    className.replace("@", "") +
    '}", ' +
    number +
    ")`)"
  );
}

async function compileAllLessFilesToCss(
  stylesDir,
  // antdStylesDir,
  varMap = {},
  varPath,
  rootEntryName = "default",
  nodeModulesPath
) {
  const stylesDirs = [].concat(stylesDir);
  let styles = [];
  stylesDirs.forEach((s) => {
    styles = styles.concat(glob.sync(path.join(s, "./**/*.less")));
  });
  const csss = await Promise.all(
    styles.map((filePath) => {
      let fileContent = combineCusLess(filePath, nodeModulesPath);
      Object.keys(varMap).forEach((varName) => {
        fileContent = fileContent.replace(
          new RegExp(`(:.*)(${varName})`, "g"),
          (match, group, a) => {
            return match.replace(varName, varMap[varName]);
          }
        );
      });
      // fileContent = `@import "${varPath}";\n${fileContent}`;
      fileContent = `@import "~antd/lib/style/themes/default.less";\n@import "${varPath}";\n${fileContent}`;
      return less
        .render(fileContent, {
          // paths: [antdStylesDir].concat(stylesDir),
          paths: [].concat(stylesDir),
          filename: path.resolve(filePath),
          javascriptEnabled: true,
          plugins: [new NpmImportPlugin({ prefix: "~" })],
        })
        .then((res) => {
          return res;
        })
        .catch((e) => {
          console.error(`Error occurred compiling file ${filePath}`);
          console.error("Error", e);
          return "\n";
        });
    })
  );
  const hashes = {};

  return csss
    .map((c) => {
      const css = stripCssComments(c.css || "", { preserve: false });
      const hashCode = hash.sha256().update(css).digest("hex");
      if (hashCode in hashes) {
        return "";
      } else {
        hashes[hashCode] = hashCode;
        return css;
      }
    })
    .join("\n");
}

async function generateTheme({
  antDir,
  // antdStylesDir,
  stylesDir,
  varFile,
  outputFilePath,
  themeVariables = ["@primary-color"],
  customColorRegexArray = [],
  rootEntryName = "default",
  prefix = "ant",
}) {
  try {
    // const antdPath = antdStylesDir || path.join(antDir, 'lib');
    const antdPath = path.join(antDir, "lib");
    const nodeModulesPath = path.join(
      antDir.slice(0, antDir.indexOf("node_modules")),
      "./node_modules"
    );

    const stylesDirs = [].concat(stylesDir);

    // 自定义的所有样式文件位置数值
    let styles = [];

    stylesDirs.forEach((s) => {
      styles = styles.concat(glob.sync(path.join(s, "./**/*.less")));
    });

    // antd样式文件主入口
    let antdStylesFile;
    if (rootEntryName === "default") {
      antdStylesFile = path.join(antDir, "./dist/antd.less");
    } else {
      antdStylesFile = path.join(antDir, `./dist/antd.${rootEntryName}.less`);
    }

    // 自定义的样式变量文件
    varFile =
      varFile || path.join(antdPath, `./style/themes/${rootEntryName}.less`);

    // 所有自定义样式读入到content变量里
    let content = "";
    styles.forEach((filePath) => {
      if (filePath.endsWith("themes/index.less")) {
        const fileContent = fs.readFileSync(filePath).toString();
        content += fileContent.replace("@{root-entry-name}", rootEntryName);
      } else {
        content += fs.readFileSync(filePath).toString();
      }
    });

    // 将自定义样式内容编码成hashCode
    // const hashCode = hash.sha256().update(content).digest('hex');

    // 如果内容没变，使用缓存的数据
    // if (hashCode === hashCache) {
    //   return cssCache;
    // }

    // 缓存内容
    // hashCache = hashCode;

    let themeCompiledVars = {};

    /*
    主题变量
    包含了antd-dark和antd-default，以及自己定义的额外变量
    */
    let themeVars = themeVariables || ["@primary-color"];

    /*
    antd的less文件路径和自定义less文件路径数组 
    [src/styles, node_modules/antd/lib/style]
    */
    const lessPaths = [path.join(antdPath, "./style")].concat(stylesDir);

    const randomColors = {};
    const randomColorsVars = {};

    // 合并所有自定义的样式文件
    const varFileContent = combineLess(varFile, nodeModulesPath);

    // 合并所有less文件到一个文件中
    let antdLess = await bundle({
      src: antdStylesFile,
      rootVars: { "root-entry-name": rootEntryName },
    });

    // 颜色算法正则数组
    customColorRegexArray = [
      ...customColorRegexArray,
      ...defaultColorRegexArray,
    ];

    // 所有自定义变量集合
    const mappings = Object.assign(
      generateColorMap(varFileContent, customColorRegexArray),
      getLessVars(varFile)
    );

    fs.writeFileSync("./theme-dist/mappings.json", JSON.stringify(mappings));

    let css = "";
    const PRIMARY_RANDOM_COLOR = "#123456";

    // 排除调色盘色值，如@primary-1
    themeVars = themeVars.filter(
      (name) => name in mappings && !name.match(/(.*)-(\d)/)
    );

    fs.writeFileSync("./theme-dist/theme.json", JSON.stringify(themeVars));

    themeVars.forEach((varName) => {
      let color = randomColor();
      if (varName === "@primary-color") {
        color = PRIMARY_RANDOM_COLOR;
      } else {
        while (
          (randomColorsVars[color] && color === PRIMARY_RANDOM_COLOR) ||
          color === "#000000" ||
          color === "#ffffff"
        ) {
          color = randomColor();
        }
      }
      randomColors[varName] = color;
      randomColorsVars[color] = varName;
      css = `.${varName.replace("@", "")} { color: ${color}; }\n ${css}`;
    });

    const colorFuncMap = {};

    let varsContent = "";
    themeVars.forEach((varName) => {
      [1, 2, 3, 4, 5, 7, 8, 9, 10].forEach((key) => {
        const name =
          varName === "@primary-color"
            ? `@primary-${key}`
            : `${varName}-${key}`;
        css = `.${name.replace("@", "")} { color: ${getShade(
          name
        )}; }\n ${css}`;
      });
      varsContent += `${varName}: ${randomColors[varName]};\n`;
    });

    fs.writeFileSync("./theme-dist/varsContent.less", varsContent);

    // This is to compile colors
    // Put colors.less content first,
    // then add random color variables to override the variables values for given theme variables with random colors
    // Then add css containinf color variable classes
    const colorFileContent = combineLess(
      path.join(antdPath, "./style/color/colors.less"),
      nodeModulesPath
    );

    fs.writeFileSync("./theme-dist/colorFileContent.less", colorFileContent);

    css = `${colorFileContent}\n${varsContent}\n${css}`;
    // css = `${colorFileContent}\n${varsContent}`;

    fs.writeFileSync("./theme-dist/css.less", css);

    let results = await render(css, lessPaths);
    css = results.css;
    css = css.replace(/(\/.*\/)/g, "");
    const regex = /.(?=\S*['-])([.a-zA-Z0-9'-]+)\ {\n {2}color: (.*);/g;
    themeCompiledVars = getMatches(css, regex);

    fs.writeFileSync("./theme-dist/test1.less", css);

    // 自定义样式
    const userCustomCss = await compileAllLessFilesToCss(
      stylesDir,
      // antdStylesDir,
      themeCompiledVars,
      varFile,
      rootEntryName,
      nodeModulesPath
    );

    fs.writeFileSync("./theme-dist/userCustomCss.less", userCustomCss);

    fs.writeFileSync(
      "./theme-dist/themeCompiledVars.json",
      JSON.stringify(themeCompiledVars)
    );

    let varsCombined = "";
    themeVars.forEach((varName) => {
      let color;
      if (/(.*)-(\d)/.test(varName)) {
        color = getShade(varName);
        return;
      } else {
        color = themeCompiledVars[varName];
      }
      varsCombined = `${varsCombined}\n${varName}: ${color};`;
    });

    fs.writeFileSync("./theme-dist/themeVars.json", JSON.stringify(themeVars));

    COLOR_FUNCTIONS.slice(1).forEach((name) => {
      antdLess = antdLess.replace(
        new RegExp(`${name}\\((.*), \\d+%\\)`, "g"),
        (fullmatch, group) => {
          if (mappings[group]) {
            return `~'${fullmatch}'`;
          }
          return fullmatch;
        }
      );
    });

    /*
      所有非 ～‘fade()’ 形式的fade函数集合
    */
    const fades = Array.from(
      new Set(antdLess.match(/(?<!(~'))fade\(.*\)(?!')/g))
    );

    /*
      将 fade() 转换为 ～‘fade()’
    */
    if (fades) {
      fades.forEach((fade) => {
        const value = fade
          .split("")
          .slice(5, fade.length - 1)
          .join("");
        if (value.startsWith("@color")) {
          antdLess = antdLess.replace(
            new RegExp(`(?<!(~'))fade\\(${value}\\)(?!')`, "g"),
            `~'fade(@{color}, @outline-fade)'`
          );
        } else {
          antdLess = antdLess.replace(
            new RegExp(`(?<!(~'))fade\\(${value}\\)(?!')`, "g"),
            `~'${fade}'`
          );
        }
      });
    }

    antdLess.replace(
      new RegExp(`.active\\(@color: @outline-color\\)`, "g"),
      `.active(@color: ~'@outline-color')`
    );

    const actives = Array.from(
      new Set(antdLess.match(/.active\(@(?!(color)).*\)/g))
    );
    if (actives) {
      actives.forEach((active) => {
        const value = active
          .split("")
          .slice(8, active.length - 1)
          .join("");
        if (value.startsWith("@border-color")) {
          antdLess = antdLess.replace(
            new RegExp(`.active\\(${value}.*\\)`, "g"),
            `.active(~'@{border-color}')`
          );
        } else {
          antdLess = antdLess.replace(
            new RegExp(`.active\\(${value}.*\\)`, "g"),
            `.active(~'${value}')`
          );
        }
      });
    }

    varsCombined = `${varsCombined}\n@ant-prefix: ${prefix};`;

    // const antLess = fs.readFileSync('./theme-dist/antdLess.less').toString()

    antdLess = `${antdLess}\n${varsCombined}`;

    fs.writeFileSync("./theme-dist/antdLess.less", antdLess);

    fs.writeFileSync("./theme-dist/varsCombined.less", varsCombined);

    // const { css: antCss } = await render(antdLess, [antdPath, antdStylesDir]);
    const { css: antCss } = await render(antdLess, [antdPath]);

    const allCss = `${antCss}\n${userCustomCss}`;

    results = await postcss([reducePlugin]).process(allCss, {
      from: antdStylesFile,
    });
    css = results.css;

    fs.writeFileSync("./theme-dist/fadeMap1.less", css);

    // Object.keys(fadeMap).forEach((fade) => {
    //   css = css.replace(new RegExp(fadeMap[fade], 'g'), fade);
    // });

    fs.writeFileSync("./theme-dist/fadeMap2.less", css);

    Object.keys(themeCompiledVars).forEach((varName) => {
      let color;
      if (/(.*)-(\d)/.test(varName)) {
        color = themeCompiledVars[varName];
        varName = getShade(varName);
      } else {
        color = themeCompiledVars[varName];
      }
      color = color.replace("(", "\\(").replace(")", "\\)");
      css = css.replace(new RegExp(color, "g"), varName);
    });

    fs.writeFileSync("./theme-dist/fadeMap3.less", css);

    Object.keys(colorFuncMap).forEach((varName) => {
      const color = colorFuncMap[varName];
      css = css.replace(new RegExp(color, "g"), varName);
    });

    fs.writeFileSync("./theme-dist/colorFuncMapReplace.less", css);

    // COLOR_FUNCTIONS.forEach((name) => {
    //   css = css.replace(new RegExp(`~'(${name}\(.*\))'`), (a, b) => {
    //     return b;
    //   });
    // });

    // Handle special cases
    // https://github.com/mzohaibqc/antd-theme-webpack-plugin/issues/69
    // 1. Replace fade(@primary-color, 20%) value i.e. rgba(18, 52, 86, 0.2)
    css = css.replace(
      new RegExp("rgba\\(18, 52, 86, 0.2\\)", "g"),
      "fade(@primary-color, 20%)"
    );

    css = css.replace(/@[\w-_]+:\s*.*;[\/.]*/gm, "");

    // This is to replace \9 in Ant Design styles
    css = css.replace(/\\9/g, "");
    css = `${css.trim()}\n${combineLess(
      path.join(antdPath, "./style/themes/default.less"),
      nodeModulesPath
    )}`;

    // fs.writeFileSync(path.join(__dirname, './theme-dist/test.less'), css);

    // themeVars.reverse().forEach((varName) => {
    //   css = css.replace(new RegExp(`${varName}( *):(.*);`, 'g'), '');
    //   css = `${varName}: ${mappings[varName]};\n${css}\n`;
    // });

    // let outputCss = await render(css);
    // outputCss = minifyCss(outputCss.css);

    // less.render(css, function (e, css) {
    //   fs.writeFileSync(outputFilePath, css);
    // });
    // console.log(css);

    css = minifyCss(css);

    if (outputFilePath) {
      fs.writeFileSync(outputFilePath, css);
      // fs.writeFileSync(outputFilePath, outputCss);
      console.log(`🌈 主题less文件生成成功. 输出地址: ${outputFilePath}`);
    } else {
      console.log("🌈 主题less文件生成成功");
    }
    cssCache = css;
    return cssCache;
  } catch (error) {
    console.log("error", error);
    return "";
  }
}

module.exports = {
  generateTheme,
  isValidColor,
  getLessVars,
  randomColor,
  minifyCss,
  renderLessContent: render,
};

function minifyCss(css) {
  // Removed all comments and empty lines
  css = css
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
    .replace(/^\s*$(?:\r\n?|\n)/gm, "");

  /*
  Converts from

    .abc,
    .def {
      color: red;
      background: blue;
      border: grey;
    }

    to

    .abc,
    .def {color: red;
      background: blue;
      border: grey;
    }

  */
  css = css.replace(/\{(\r\n?|\n)\s+/g, "{");

  /*
  Converts from

  .abc,
  .def {color: red;
  }

  to

  .abc,
  .def {color: red;
    background: blue;
    border: grey;}

  */
  css = css.replace(/;(\r\n?|\n)\}/g, ";}");

  /*
  Converts from

  .abc,
  .def {color: red;
    background: blue;
    border: grey;}

  to

  .abc,
  .def {color: red;background: blue;border: grey;}

  */
  css = css.replace(/;(\r\n?|\n)\s+/g, ";");

  /*
Converts from

.abc,
.def {color: red;background: blue;border: grey;}

to

.abc, .def {color: red;background: blue;border: grey;}

*/
  css = css.replace(/,(\r\n?|\n)[.]/g, ", .");
  return css;
}

function combineCusLess(filePath, nodeModulesPath) {
  const fileContent = fs.readFileSync(filePath).toString();
  const directory = path.dirname(filePath);
  return fileContent
    .split("\n")
    .map((line) => {
      if (line.startsWith("@import") && !line.includes("default.less")) {
        let importPath = line.match(/@import[^'"]*['"](.*)['"]/)[1];
        if (!importPath.endsWith(".less")) {
          importPath += ".less";
        }
        let newPath = path.join(directory, importPath);
        if (importPath.startsWith("~")) {
          importPath = importPath.replace("~", "");
          newPath = path.join(nodeModulesPath, `./${importPath}`);
        }
        return combineCusLess(newPath, nodeModulesPath);
      }
      return line;
    })
    .join("\n");
}

// 合并所有关联的less文件
function combineLess(filePath, nodeModulesPath) {
  const fileContent = fs.readFileSync(filePath).toString();
  const directory = path.dirname(filePath);
  return fileContent
    .split("\n")
    .map((line) => {
      if (line.startsWith("@import")) {
        let importPath = line.match(/@import[^'"]*['"](.*)['"]/)[1];
        if (!importPath.endsWith(".less")) {
          importPath += ".less";
        }
        let newPath = path.join(directory, importPath);
        if (importPath.startsWith("~")) {
          importPath = importPath.replace("~", "");
          newPath = path.join(nodeModulesPath, `./${importPath}`);
        }
        return combineLess(newPath, nodeModulesPath);
      }
      return line;
    })
    .join("\n");
}
