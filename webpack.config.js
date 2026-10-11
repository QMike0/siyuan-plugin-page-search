const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const {EsbuildPlugin} = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");
const {name: pluginName} = require("./plugin.json");

module.exports = (env, argv) => {
    const production = argv.mode === "production";
    const plugins = [
        new MiniCssExtractPlugin({
            filename: "index.css",
        }),
    ];
    if (production) {
        plugins.push(
            new webpack.BannerPlugin({
                banner: () => {
                    return fs.readFileSync("LICENSE").toString();
                },
            }),
        );
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "preview.png", to: "./"},
                    {from: "icon.png", to: "./"},
                    {from: "README*.md", to: "./"},
                    {from: "plugin.json", to: "./"},
                    {from: "src/i18n/", to: "./i18n/"},
                    {from: "dist/kernel.js", to: "./"},
                ],
            }),
        );
        plugins.push(
            new ZipPlugin({
                filename: "package.zip",
                path: __dirname,
                algorithm: "gzip",
            }),
        );
    } else {
        plugins.push(
            new CopyPlugin({
                patterns: [
                    {from: "src/i18n/", to: "./i18n/"},
                ],
            }),
        );
    }
    return {
        mode: argv.mode || "development",
        watch: !production,
        devtool: production ? false : "eval-source-map",
        output: {
            filename: "[name].js",
            chunkFilename: "[name].js",
            path: path.resolve(__dirname, production ? "dist" : "."),
            // 思源以 eval 执行插件代码，不能从 document.currentScript 推导插件地址。
            // 构建目录和安装包内部保持同一布局，Worker 使用思源的插件静态资源路由。
            publicPath: `/plugins/${encodeURIComponent(pluginName)}/`,
        },
        externalsType: "commonjs",
        externals: {
            siyuan: "siyuan",
        },
        entry: {
            // CommonJS 仅用于思源插件入口；Worker 不具备 module / exports 全局变量。
            index: {
                import: "./src/index.ts",
                library: {type: "commonjs2"},
            },
        },
        optimization: {
            minimize: production,
            minimizer: [
                new EsbuildPlugin(),
            ],
        },
        resolve: {
            extensions: [".ts", ".scss", ".js", ".json"],
        },
        module: {
            rules: [
                {
                    test: /\.ts(x?)$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        {
                            loader: "esbuild-loader",
                            options: {
                                target: "es6",
                                // 交给 webpack 5 识别 new Worker(new URL(..., import.meta.url))，
                                // 不能由 esbuild 按 ES6 降级成空对象，否则 Worker 资源不会产出。
                                supported: {
                                    "import-meta": true,
                                },
                            },
                        },
                    ],
                },
                {
                    test: /\.scss$/,
                    include: [path.resolve(__dirname, "src")],
                    use: [
                        MiniCssExtractPlugin.loader,
                        {
                            loader: "css-loader", // translates CSS into CommonJS
                        },
                        {
                            loader: "sass-loader", // compiles Sass to CSS
                        },
                    ],
                },
            ],
        },
        plugins,
    };
};
