const fs = require('fs');
const path = require('path');
const glob = require('glob');
const postcss = require('postcss');
const less = require('less');
const bundle = require('less-bundle-promise');
const NpmImportPlugin = require('less-plugin-npm-import');

let cssCache = '';

// antd涉及的颜色函数
const COLOR_FUNCTIONS = [
  'color',
  'lighten',
  'darken',
  'saturate',
  'desaturate',
  'fadein',
  'fadeout',
  'fade',
  'spin',
  'mix',
  'hsv',
  'tint',
  'shade',
  'greyscale',
  'multiply',
  'contrast',
  'screen',
  'overlay'
];

// 转换为颜色函数的正则匹配：/color(.*)/,  /lighten(.*)/,
const antdColorRegexArray = COLOR_FUNCTIONS.map(
  (name) => new RegExp(`${name}\(.*\)`)
);

// 生成随机16进制颜色
function randomColor () {
  return (
    '#' + (0x1000000 + Math.random() * 0xffffff).toString(16).substring(1, 7)
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
function getColor (varName, mappings) {
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
function isValidColor (color) {
  if (color && color.includes('rgb')) return true;
  if (!color || color.match(/px/g)) return false;
  if (color.match(/colorPalette|fade/g)) return true;
  if (color.charAt(0) === '#') {
    color = color.substring(1);
    return (
      [3, 4, 6, 8].indexOf(color.length) > -1 && !isNaN(parseInt(color, 16))
    );
  }
  const isColor =
    /^(rgb|hsl|hsv)a?\((\d+%?(deg|rad|grad|turn)?[,\s]+){2,3}[\s\/]*[\d\.]+%?\)$/i.test(
      color
    );
  if (isColor) return true;

  // antd颜色函数也算合法
  if (antdColorRegexArray.length > 0) {
    return antdColorRegexArray.reduce((prev, regex) => {
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
function generateColorMap (content) {
  content = content.replace(/\((\s*\r\n?|\s*\n)\s*~/g, '(~');
  content = content.replace(/`(\s*\r\n?|\s*\n)\s*\);/g, '`);');
  content = content.replace(/,(\s*\r\n?|\s*\n)\s*(purple;)/g, ', purple;');
  return content
    .split('\n')
    .filter((line) => line.startsWith('@') && line.indexOf(':') > -1)
    .reduce((prev, next) => {
      try {
        const matches = next.match(/(?=\S*)([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/);
        if (!matches) {
          return prev;
        }
        let [, varName, color] = matches;
        if (color && color.startsWith('@')) {
          color = getColor(color, prev);
          if (!isValidColor(color)) return prev;
          prev[varName] = color;
        } else if (isValidColor(color)) {
          prev[varName] = color;
        }
        return prev;
      } catch (e) {
        console.log('e', e);
        return prev;
      }
    }, {});
}

function filterColorVariables (content, mappings) {
  content = content.replace(/\((\s*\r\n?|\s*\n)\s*~/g, '(~');
  content = content.replace(/`(\s*\r\n?|\s*\n)\s*\);/g, '`);');
  content = content.replace(/,(\s*\r\n?|\s*\n)\s*(purple;)/g, ', purple;');
  return content
    .split('\n')
    .filter((line) => {
      try {
        if (line.startsWith('@') && line.indexOf(':') > -1) {
          if (line.startsWith('@preset-colors') || line.startsWith('@outline-fade')) return true;
          const matches = line.match(/(?=\S*)([@a-zA-Z0-9'-]+).*:[ ]{1,}(.*);/);
          const [, , color] = matches;
          if (color && color.startsWith('@')) {
            if (!isValidColor(getColor(color, mappings))) return false;
            return true;
          } else {
            if (color === 'inherit') return true;
          }
          return isValidColor(color);
        }
      } catch (e) {
        return false;
      }
      return false;
    })
    .join('\n');
}

// 过滤只包含颜色的css属性
const reducePlugin = postcss.plugin('reducePlugin', () => {
  const cleanRule = (rule) => {
    if (rule.selector.startsWith('.main-color .palatte-')) {
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
        !decl.prop.includes('color') &&
        !decl.prop.includes('background') &&
        !decl.prop.includes('border') &&
        !decl.prop.includes('box-shadow') &&
        !decl.prop.includes('stroke') &&
        !decl.prop.includes('fill') &&
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

function getMatches (string, regex) {
  const matches = {};
  let match;
  while ((match = regex.exec(string))) {
    if (match[2].startsWith('rgba') || match[2].startsWith('#')) {
      matches[`@${match[1]}`] = match[2];
    }
  }
  return matches;
}

// 将less编译为css
function render (text, paths) {
  return less.render(text, {
    paths: paths,
    javascriptEnabled: true,
    plugins: [new NpmImportPlugin({ prefix: '~' })]
  });
}

/*
  将less文件转换为对象
  {
    '@primary-color' : '#1890ff',
    '@heading-color' : '#fa8c16',
    '@text-color' : '#cccccc'
  }
*/
function getLessVarsObj (content) {
  const lessVars = {};
  const matches = content.match(/@(.*:[^;]*)/g) || [];

  matches.forEach((variable) => {
    const definition = variable.split(/:\s*/);
    const varName = definition[0].replace(/['"]+/g, '').trim();
    lessVars[varName] = definition.splice(1).join(':');
  });
  return lessVars;
}

function getLessVars (filtPath) {
  const sheet = fs.readFileSync(filtPath).toString();
  let lessVars = {};
  lessVars = getLessVarsObj(sheet);
  return lessVars;
}

/*
  Input: @primary-1
  Output: color(~`colorPalette("@{primary-color}", ' 1 ')`)
*/
function getShade (varName) {
  let [, className, number] = varName.match(/(.*)-(\d)/);
  if (/primary-\d/.test(varName)) className = '@primary-color';
  return (
    'color(~`colorPalette("@{' +
    className.replace('@', '') +
    '}", ' +
    number +
    ')`)'
  );
}

async function generateTheme ({
  antDir,
  stylesDir,
  varFile,
  outputFilePath,
  themeVariables = ['@primary-color'],
  rootEntryName = 'default',
  prefix = 'ant'
}) {
  try {
    const antdPath = path.join(antDir, 'lib');
    const nodeModulesPath = path.join(
      antDir.slice(0, antDir.indexOf('node_modules')),
      './node_modules'
    );

    // antd样式文件主入口
    let antdStylesFile;
    if (rootEntryName === 'default') {
      antdStylesFile = path.join(antDir, './dist/antd.less');
    } else {
      antdStylesFile = path.join(antDir, `./dist/antd.${rootEntryName}.less`);
    }

    // 自定义的样式变量文件
    varFile =
      varFile || path.join(antdPath, `./style/themes/${rootEntryName}.less`);

    // 所有自定义样式读入到content变量里
    let styles = [];
    const stylesDirs = [].concat(stylesDir);
    stylesDirs.forEach((s) => {
      styles = styles.concat(glob.sync(path.join(s, './**/*.less')));
    });

    let themeCompiledVars = {};

    /*
    主题变量
    包含了antd-dark和antd-default，以及自己定义的额外变量
    */
    let themeVars = themeVariables || ['@primary-color'];

    const lessPaths = [path.join(antdPath, './style')].concat(stylesDir);

    const randomColors = {};
    const randomColorsVars = {};

    // 合并所有自定义的样式文件
    const varFileContent = combineLess(varFile, nodeModulesPath);

    // 合并所有less文件到一个文件中
    let antdLess = await bundle({
      src: antdStylesFile,
      rootVars: { 'root-entry-name': rootEntryName }
    });

    // 所有变量集合
    const mappings = Object.assign(
      generateColorMap(varFileContent),
      getLessVars(varFile)
    );

    let css = '';
    const PRIMARY_RANDOM_COLOR = '#123456';

    // 排除调色盘色值，如@primary-1
    themeVars = themeVars.filter(
      (name) => name in mappings && !name.match(/(.*)-(\d)/)
    );

    themeVars.forEach((varName) => {
      let color = randomColor();
      if (varName === '@primary-color') {
        color = PRIMARY_RANDOM_COLOR;
      } else {
        while (
          (randomColorsVars[color] && color === PRIMARY_RANDOM_COLOR) ||
          color === '#000000' ||
          color === '#ffffff'
        ) {
          color = randomColor();
        }
      }
      randomColors[varName] = color;
      randomColorsVars[color] = varName;
      css = `.${varName.replace('@', '')} { color: ${color}; }\n ${css}`;
    });

    let varsContent = '';
    themeVars.forEach((varName) => {
      [1, 2, 3, 4, 5, 7, 8, 9, 10].forEach((key) => {
        const name =
          varName === '@primary-color'
            ? `@primary-${key}`
            : `${varName}-${key}`;
        css = `.${name.replace('@', '')} { color: ${getShade(
          name
        )}; }\n ${css}`;
      });
      varsContent += `${varName}: ${randomColors[varName]};\n`;
    });

    const colorFileContent = combineLess(
      path.join(antdPath, './style/color/colors.less'),
      nodeModulesPath
    );

    css = `${colorFileContent}\n${varsContent}\n${css}`;

    let results = await render(css, lessPaths);
    css = results.css;
    css = css.replace(/(\/.*\/)/g, '');
    const regex = /.(?=\S*)([.a-zA-Z0-9'-]+)\ {\n {2}color: (.*);/g;

    themeCompiledVars = getMatches(css, regex);

    const userCustomLess = styles
      .map((path) => {
        return combineLess(path, nodeModulesPath, !/(default.less)/);
      })
      .join('\n');

    let varsCombined = '';
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

    COLOR_FUNCTIONS.slice(1).forEach((name) => {
      antdLess = antdLess.replace(
        new RegExp(`${name}\\((.*), \\d+%\\)`, 'g'),
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
          .split('')
          .slice(5, fade.length - 1)
          .join('');
        const firstValue = value.split(',')[0];
        if (
          firstValue.startsWith('@') &&
          firstValue.indexOf('-') === -1 &&
          firstValue.indexOf('black') === -1 &&
          firstValue.indexOf('white') === -1
        ) {
          antdLess = antdLess.replace(
            new RegExp(`(?<!(~'))fade\\(${value}\\)(?!')`, 'g'),
            `~'fade(@{${firstValue.substring(
              1,
              firstValue.length
            )}}, @outline-fade)'`
          );
        } else {
          antdLess = antdLess.replace(
            new RegExp(`(?<!(~'))fade\\(${value}\\)(?!')`, 'g'),
            `~'${fade}'`
          );
        }
      });
    }

    // antdLess.replace(
    //   new RegExp('.active\\(@color: @outline-color\\)', 'g'),
    //   '.active(@color: ~\'@outline-color\')'
    // );

    varsCombined += `\n@ant-prefix: ${prefix};`;

    const allLess = `${antdLess}\n${userCustomLess}\n${varsCombined}`;

    const { css: allCss } = await render(allLess, [antdPath]);

    results = await postcss([reducePlugin]).process(allCss, {
      from: antdStylesFile
    });
    css = results.css;

    Object.keys(themeCompiledVars).forEach((varName) => {
      let color;
      if (/(.*)-(\d)/.test(varName)) {
        color = themeCompiledVars[varName];
        varName = getShade(varName);
      } else {
        color = themeCompiledVars[varName];
      }
      color = color.replace('(', '\\(').replace(')', '\\)');
      css = css.replace(new RegExp(color, 'g'), varName);
    });

    // 调色盘函数
    const colorPaletteContent = combineLess(
      path.join(antdPath, './style/color/colorPalette.less'),
      nodeModulesPath
    );

    // 颜色变量
    const variables = `${filterColorVariables(varFileContent, mappings)}`;

    css = css.replace(/@[\w-_]+:\s*.*;[\/.]*/gm, '');
    css = css.replace(/\\9/g, '').trim();
    css += `\n${colorPaletteContent}\n${variables}`;
    css = minifyCss(css);

    if (outputFilePath) {
      fs.writeFileSync(outputFilePath, css);
    }
    cssCache = css;
    return cssCache;
  } catch (error) {
    console.log('error', error);
    return '';
  }
}

module.exports = {
  generateTheme,
  isValidColor,
  getLessVars,
  randomColor,
  minifyCss,
  renderLessContent: render
};

function minifyCss (css) {
  // Removed all comments and empty lines
  css = css
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
    .replace(/^\s*$(?:\r\n?|\n)/gm, '');

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
  css = css.replace(/\{(\r\n?|\n)\s+/g, '{');

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
  css = css.replace(/;(\r\n?|\n)\}/g, ';}');

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
  css = css.replace(/;(\r\n?|\n)\s+/g, ';');

  /*
Converts from

.abc,
.def {color: red;background: blue;border: grey;}

to

.abc, .def {color: red;background: blue;border: grey;}

*/
  css = css.replace(/,(\r\n?|\n)[.]/g, ', .');
  return css;
}

// 合并所有关联的less文件
function combineLess (filePath, nodeModulesPath, filterReg = /.*/) {
  const fileContent = fs.readFileSync(filePath).toString();
  const directory = path.dirname(filePath);
  return fileContent
    .split('\n')
    .map((line) => {
      if (line.startsWith('@import')) {
        if (filterReg && filterReg.test(line)) {
          let importPath = line.match(/@import[^'"]*['"](.*)['"]/)[1];
          if (!importPath.endsWith('.less')) {
            importPath += '.less';
          }
          let newPath = path.join(directory, importPath);
          if (importPath.startsWith('~')) {
            importPath = importPath.replace('~', '');
            newPath = path.join(nodeModulesPath, `./${importPath}`);
          }
          return combineLess(newPath, nodeModulesPath);
        } else {
          return '';
        }
      }
      return line;
    })
    .join('\n');
}
