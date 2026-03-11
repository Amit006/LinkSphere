const path = require('path');
const slsw = require('serverless-webpack');

module.exports = {
  entry: slsw.lib.entries,
  target: 'node16',
  mode: slsw.lib.webpack.isLocal ? 'development' : 'production',
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@linksphere/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
  output: {
    libraryTarget: 'commonjs2',
    path: path.join(__dirname, '.webpack'),
    filename: '[name].js',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          transpileOnly: true, // Faster builds — type checking handled by tsc separately
        },
      },
    ],
  },
  // Don't bundle AWS SDK — it's provided by the Lambda runtime
  externals: ['aws-sdk', '@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'],
};