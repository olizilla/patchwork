var path        = require('path')
var multicb     = require('multicb')
var toPath      = require('multiblob/util').toPath
var createHash  = require('multiblob/util').createHash
var pull        = require('pull-stream')
var toPull      = require('stream-to-pull-stream')
var querystring = require('querystring')
var fs          = require('fs')

module.exports = function (sbot, config) {
  var fallback_img_path = path.join(__dirname, '../../node_modules/ssb-patchwork-ui/img/default-prof-pic.png')
  var fallback_video_path = path.join(__dirname, '../../node_modules/ssb-patchwork-ui/img/spinner.webm')
  var nowaitOpts = { nowait: true }, id = function(){}

  return {
    // copy file from blobs into given dir with nice name
    checkout: function (url, cb) {
      var parsed = url_parse(url)
      if (!parsed)
        return cb({ badUrl: true })
      
      var filename = parsed.qs.name || parsed.qs.filename || parsed.hash

      // check if we have the blob, at the same time find an available filename
      var done = multicb()
      fs.stat(toPath(config.blobs_dir, parsed.hash), done())
      findCheckoutDst(filename, parsed.hash, done())
      done(function (err, res) {
        if (err && err.code == 'ENOENT')
          return cb({ notFound: true })

        // do we need to copy?
        var dst = res[1][1]
        var nocopy = res[1][2]
        if (nocopy)
          return cb(null, dst)

        // copy the file
        var src = toPath(config.blobs_dir, parsed.hash)
        var read = fs.createReadStream(src)
        var write = fs.createWriteStream(dst)
        read.on('error', done)
        write.on('error', done)
        write.on('close', done)
        read.pipe(write)
        function done (err) {
          cb && cb(err, dst)
          cb = null
        }
      })
    },

    server: function (opts) {
      opts = opts || {}
      return function (req, res) {
        // local-host only
        if (req.socket.remoteAddress != '127.0.0.1' &&
            req.socket.remoteAddress != '::ffff:127.0.0.1' &&
            req.socket.remoteAddress != '::1') {
          console.log('Remote access attempted by', req.socket.remoteAddress)
          res.writeHead(403)
          return res.end('Remote access forbidden')
        }

        // restrict the CSP
        res.setHeader('Content-Security-Policy', 
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' data:; "+
          "connect-src 'self'; "+
          "object-src 'none'; "+
          "frame-src 'none'; "+
          "sandbox allow-scripts"
        )

        if (req.url.slice(-7) != '.sha256' && opts.serveFiles) {
          // try to serve from local FS if the path is not a supported hash
          return fs.createReadStream(req.url)
            .on('error', function () {
              res.writeHead(404)
              res.end('File not found')
            })
            .pipe(res)
        }

        // serve blob
        var parsed = url_parse(req.url)
        sbot.blobs.has(parsed.hash, function(err, has) {
          if (!has) {
            sbot.blobs.want(parsed.hash, nowaitOpts, id)
            if (parsed.qs.fallback) {
              var p = (parsed.qs.fallback == 'video') ? fallback_video_path : fallback_img_path
              console.log('falling back', p)
              return fs.createReadStream(p)
                .on('error', function () {
                  res.writeHead(404)
                  res.end('File not found')
                })
                .pipe(res)
            }
            res.writeHead(404)
            res.end('File not found')
            return
          }
          pull(
            sbot.blobs.get(parsed.hash),
            toPull(res)
          )
        })
      }
    }
  }

  // helper to create a filename in checkout_dir that isnt already in use
  // - cb(err, filepath, nocopy) - if nocopy==true, no need to do the copy operation
  function findCheckoutDst (filename, hash, cb) {
    var n = 1
    var parsed = path.parse(filename)
    next()

    function gen () {
      var name = parsed.name
      if (n !== 1) name += ' ('+n+')'
      name += parsed.ext
      n++
      return path.join(config.checkout_dir, name)
    }

    function next () {
      var dst = gen()
      // exists?
      fs.stat(dst, function (err, stat) {
        if (!stat)
          return cb(null, dst, false)

        // yes, check its hash
        var hasher = createHash('sha256')
        pull(
          toPull.source(fs.createReadStream(dst)),
          hasher,
          pull.onEnd(function () {
            // if the hash matches, we're set
            if (hasher.digest == hash)
              return cb(null, dst, true)
            // try next
            next()
          })
        )
      })
    }
  }
}

// blob url parser
// var re = /^pwblob:&([a-z0-9\+\/=]+\.(?:sha256|blake2s))\??(.*)$/i
// var url_parse =
// module.exports.url_parse = function (str) {
//   var parts = re.exec(str)
//   if (parts)
//     return { hash: parts[1], qs: querystring.parse(parts[2]) }
// }
var re = /^(?:http:\/\/localhost:7777)?\/&([a-z0-9\+\/=]+\.(?:sha256|blake2s))\??(.*)$/i
var url_parse =
module.exports.url_parse = function (str) {
  var parts = re.exec(str)
  if (parts)
    return { hash: parts[1], qs: querystring.parse(parts[2]) }
}

// blob url builder
var url_stringify =
module.exports.url_stringify = function (hash, qs) {
  var url = 'blob:'+hash
  if (qs && typeof qs == 'object')
    url += '?' + querystring.stringify(qs)
  return url
}