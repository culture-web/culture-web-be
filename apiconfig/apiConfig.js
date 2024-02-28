module.exports =
  process.env.NODE_ENV === 'development'
    ? require('./localApiConfig')
    : require('./prodApiConfig');
