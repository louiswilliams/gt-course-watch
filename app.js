var express = require('express'),
    app = express(),
    server = require('http').createServer(app).listen(process.env.HTTP_PORT || 8080),
    io = require('socket.io').listen(server),
    hbs = require('hbs'),
    fs = require('fs'),
    ObjectId = require('mongoose').Types.ObjectId,

    MongoController = require('./MongoController.js'),
    Mailer = require('./Mailer.js'),
    Poller = require('./Poller.js'),
    PhantomJobDispatcher = require('./PhantomJobDispatcher.js'),
    TermManager = require('./TermManager.js'),
    CatalogConnector = require('./CatalogConnector.js');

/*****
username and email are synonymous through this application
*****/

//LESSON LEARNED: In a one to many relationship, store the value of the one object as a field in each of the
// many objects... This way, querying is SO much easier.

//secury copy paste command
// scp -i GTCW.pem /Users/vikram/amazon_ec2/gtcw_gmail_pass.txt ec2-user@54.204.32.244:/home/ec2-user

//*CONFIG
var mongo_url = 'mongodb://localhost/gtcw',
    THROTTLE_DELAY_SECS = 8,
    PHANTOM_EVENTLOOP_DELAY_MS = 2000,
    PROD_EMAIL_SERVICE = 'ses',
    HTTPS_ENABLED = (process.env.HTTPS_ENABLED == "true" ? true : false),
    TERM_PRODUCER_DELAY, //TermManager
    TERM_CONSUMER_DELAY; //CatalogConnector

console.log("HTTPS ENABLED:", HTTPS_ENABLED);

//*CONSTANTS
var millisInSecond = 1000,
    millisInMinute = millisInSecond*60,
    millisInHour = millisInMinute*60,
    millisInDay = millisInHour*24;

if(process.env.BUILD_ENVIRONMENT == 'production') {
  if(HTTPS_ENABLED){
    var https_opts = {
      key: fs.readFileSync("/home/ec2-user/ssl_key.pem"),
      cert: fs.readFileSync("/home/ec2-user/certs/www_gtcoursewatch_us.crt"),
      ca: [
        fs.readFileSync("/home/ec2-user/certs/AddTrustExternalCARoot.crt"),
        fs.readFileSync("/home/ec2-user/certs/COMODORSAAddTrustCA.crt"),
        fs.readFileSync("/home/ec2-user/certs/COMODORSADomainValidationSecureServerCA.crt")
      ]
    }

    var secureServer = require('https').createServer(https_opts, app).listen( process.env.HTTPS_PORT || 8000);
    var hostName = "https://www.gtcoursewatch.us";
  }else {
    var hostName = "http://www.gtcoursewatch.us";
  }

  if(PROD_EMAIL_SERVICE == 'gmail') {
    var mailerEmail = "louieaw@gmail.com";
    var mailerPass = fs.readFileSync("gtcw_gmail_pass.txt").toString();
    var myMailer = new Mailer(mailerEmail, 
      { service: 'gmail', 
        pass: mailerPass });
  } else if(PROD_EMAIL_SERVICE == 'ses') {
    var mailerEmail = "admin@gtcoursewatch.us";

    if(process.env.HOST_PROVIDER.toLowerCase() == 'digitalocean') {
      var ses_creds = JSON.parse( fs.readFileSync('/root/ses_config.json') );
    }else if(process.env.HOST_PROVIDER.toLowerCase() == 'amazon') {
      var ses_creds = JSON.parse( fs.readFileSync('/home/ec2-user/ses_config.json') );
    }

    var myMailer = new Mailer(mailerEmail, 
      { service: 'ses', 
        id: ses_creds.accessKeyID,
        sekret: ses_creds.accessKeySecret });
  }

  TERM_PRODUCER_DELAY = 2*millisInMinute;
  TERM_CONSUMER_DELAY = 1*millisInMinute;

  registerPartials();
} else {
  if (HTTPS_ENABLED) {
    var https_opts = {
      key: fs.readFileSync("/Users/vikram/amazon_ec2/ssl_key.pem"),
      cert: fs.readFileSync("/Users/vikram/amazon_ec2/gtcw_ssl_certs/www_gtcoursewatch_us.crt"),
      ca: [
        fs.readFileSync("/Users/vikram/amazon_ec2/gtcw_ssl_certs/AddTrustExternalCARoot.crt"),
        fs.readFileSync("/Users/vikram/amazon_ec2/gtcw_ssl_certs/COMODORSAAddTrustCA.crt"),
        fs.readFileSync("/Users/vikram/amazon_ec2/gtcw_ssl_certs/COMODORSADomainValidationSecureServerCA.crt")
      ]
    }

    var secureServer = require('https').createServer(https_opts, app).listen(8000);
  }
  var hostName = "http://localhost:8080";
  var mailerEmail = "louieaw@gmail.com";
  var mailerPass = fs.readFileSync("gtcw_gmail_pass.txt").toString();
  var myMailer = new Mailer(mailerEmail, 
    { service: 'gmail', 
      pass: mailerPass });

  TERM_PRODUCER_DELAY = .1*millisInMinute;
  TERM_CONSUMER_DELAY = .1*millisInMinute;

  //keep reloading partials
  setInterval(registerPartials, 1000);
}

if(HTTPS_ENABLED) io.listen(secureServer);

//Ensure partial registration on startup
(function() {
  var partials_path = "./views/partials";
      partial_files = fs.readdirSync(partials_path);

  partial_files.forEach(function(partial) {
    var matches = /^([^.]+).hbs.html$/.exec(partial);
    if (!matches) { return };
    var name = matches[1];

    var partial = fs.readFileSync(partials_path + "/" + partial, 'utf8');
    hbs.registerPartial(name, partial);
  });
})();


//*INITIALIZE CUSTOM MODULES
var myMongoController = new MongoController();
myMongoController.connect(mongo_url, function (connection) {
  
  myMongoController.getFulfillmentStats(function(stats) {
    fulfillment_stats = stats;
  });
});
// var myTermManager = new TermManager(mongo_url, TERM_PRODUCER_DELAY);
// var myCatalogConnector = 
//   new CatalogConnector(mongo_url, myTermManager, TERM_CONSUMER_DELAY);
var myDispatcher = new PhantomJobDispatcher( myMailer, myMongoController);
myDispatcher.startDispatcher(PHANTOM_EVENTLOOP_DELAY_MS);

var springPoller, fallPoller, summerPoller; //pollers
var current_pollers; //object that holds all current pollers
var springTerm, fallTerm, summerTerm; //string ids of current terms, also used to tell which terms to poll
var rejectRequests = false;
var fulfillment_stats = {
          fulfilled: 0,
          total: 0,
          rate: 0
        };

initPollers();

console.log('Spring Null? ' + (current_pollers['spring'] == null).toString());
console.log('Fall Null? ' + (current_pollers['fall'] == null).toString());
console.log('Summer Null? ' + (current_pollers['summer'] == null).toString());

//*Express Config
app.use(express.cookieParser());
var sessionStore = new express.session.MemoryStore; //equivalent to new express.session.MemoryStore()
app.use(express.session({secret: generateUUID(), store:sessionStore}));

app.configure(function() {

  app.use(express.compress());

  //middleware + res.locals
  app.use(function(req, res, next) {
    if (req.session && req.session.username) {
      res.locals.username = req.session.username;
    }
    next();
  });

  //my implementation of flash
  app.use(function(req, res, next) {
    res.locals.success_flash = req.session.success_flash;
    res.locals.warning_flash = req.session.warning_flash;
    res.locals.danger_flash = req.session.danger_flash;
    req.session.success_flash = null;
    req.session.warning_flash = null;
    req.session.danger_flash = null;
    next();
  });
});

app.set('view engine', 'html');
app.engine('html', hbs.__express);

app.use(express.bodyParser());
app.use(app.router);
app.use(express.static('public'));

app.get('/', function(req, res) {
  var springLabel, summerLabel, fallLabel;

  //initialize labels only if terms are active
  if(springTerm) springLabel = createLabel(springTerm);
  if(summerTerm) summerLabel = createLabel(summerTerm);
  if(fallTerm) fallLabel = createLabel(fallTerm);

  res.render('index', {
    title: 'GT CourseWatch', 
    spring: springTerm,
    summer: summerTerm,
    fall: fallTerm,
    springLabel: springLabel,
    summerLabel: summerLabel,
    fallLabel: fallLabel
  });
});

app.get('/about', function(req, res) {
  res.render('about', {title:"About"});
});

//verify buzzport for automated registration
app.post('/verifyBuzzport', function(req, res) {
  var post = req.body;
  strip_whitespace_from_obj(post);

  myDispatcher.addVerifyTaskToQueue(
    {  
      username: post.username, 
      password: post.password 
    }, 
    function(status) {
      res.json({status: status});
    }
  );
});

//submit an automated registration request.
app.post('/autoRegReq', function(req, res) {
  var post = req.body;
  post.term = post.term.replace(' ', '-');
  strip_whitespace_from_obj(post);

  var user = req.session.username;

  if(user) {
    myMongoController.createAutoRegReq(post.crn, post.email, post.term, post.username, post.password, function(doc) {

      myMongoController.userAccessor(user, function(user_arr) {
        user_arr[0].auto_reqs.push(doc._id);        
        user_arr[0].save();
      });

      myMongoController.createConfirmationStat(0,0,1);
      myMailer.sendConfirmationMail(post.email, post.crn, false, true);
    });  

    res.json({status: "SUCCESS"});
  } else{
    res.json({status: "NOT_LOGGED_IN"});
  }
});

//submit a regular, email only request
app.post('/reg_req_sub', function(req, res) {
  var post = req.body;
  strip_whitespace_from_obj(post);

  myMongoController.createRequest(post.crn, post.email, post.term, function(doc) {
    var user = req.session.username;

    if(user) {
      myMongoController.userAccessor(user, function(user_arr) {
        user_arr[0].reg_reqs.push(doc._id);        
        user_arr[0].save();
      });
    }

    myMailer.sendConfirmationMail(post.email, post.crn, false, false);
    myMongoController.createConfirmationStat(1,0,0);
    myMongoController.addToArchive('REG', post.email, post.term, 
      post.crn, null);

    res.json({status: "SUCCESS"});
  });
});

//submit a email + sms reuqest
app.post('/sms_req_sub', function(req, res) {
  var post = req.body;
  strip_whitespace_from_obj(post);

  myMongoController.createSMSRequest(post.crn, post.email, post.gatewayedNumber, post.term, function(doc) {
    var user = req.session.username;

    if(user) {
      myMongoController.userAccessor(user, function(user_arr) {
        user_arr[0].sms_reqs.push(doc._id);        
        user_arr[0].save();  
      });
    }

    myMailer.sendConfirmationMail(post.email, post.crn, true, false);
    myMongoController.createConfirmationStat(0,1,0);
    myMongoController.addToArchive('SMS', post.email, 
      post.term, post.crn, post.gatewayedNumber);

    res.json({status: "SUCCESS"});
  });
});


//Throttling
app.get('/getTimeoutStatus', function(req, res) {
  var THROTTLE_DELAY_MS = THROTTLE_DELAY_SECS*millisInSecond;

  if(req.session.last_throttle_time == null) {
    //initial hit
    req.session.last_throttle_time = Date.now();
    res.json({status:"good"});
  } else{
    //check if timeoout is up
    var timeDelta = Date.now() - req.session.last_throttle_time;
    if( timeDelta < THROTTLE_DELAY_MS) res.json({status:"bad", timeLeft: (THROTTLE_DELAY_MS-timeDelta)/1000});
    else{
      req.session.last_throttle_time = Date.now();
      res.json({status:"good"})
    }
  }
});

app.get('/getFulfillmentStats', function(req, res) {
  res.json(fulfillment_stats);
});

//get the number of other people in our database watching a particular CRN when a user makse a request
app.get('/getNumWatchers/:crn', function(req, res) {
  strip_whitespace_from_obj(req.params);

  myMongoController.Request.find({crn:req.params.crn}, function(err, requests) {
    myMongoController.smsRequest.find({crn:req.params.crn}, function(err, smsRequests) {
      //since stat is for 'other watcher' we don't include the request just made by the user, hence the -1
      //we also don't want to accidently display a negative value
      var numWatchers = Math.max(smsRequests.length + requests.length - 1 , 0);
      res.json({numWatchers: numWatchers}); 
    });
  });
});

//Send OSCAR scraped stats for capacity, remaining, etc. AND number of people in our database watching a seat.
app.get('/getStats/:crn/:term', function(req, res) {
  strip_whitespace_from_obj(req.params);

  myMongoController.Request.find({crn:req.params.crn}, function(err, requests) {
    myMongoController.smsRequest.find({crn:req.params.crn}, function(err, smsRequests) {
      var pollers = getActivePollers(),
          termPoller;

      pollers.forEach(function(poller) {
        if(poller.term == req.params.term) termPoller = poller;
      });

      //not executed asyncronously since forEach is blocking
      if(termPoller) {
        termPoller.getSeatStats(req.params.crn, function(crn, result) {
          result['numWatchers'] = requests.length + smsRequests.length;
          res.send(result);
        });        
      } else{
        if(!termPoller) res.send("bad req");
      }

    });
  });
});

//verify a CRN on request forms
app.get('/verifyCRN/:crn/:term', function(req, res) {
  var pollers = getActivePollers(),
      termPoller;

  strip_whitespace_from_obj(req.params);

  pollers.forEach(function(poller) {
    if(poller.term==req.params.term) termPoller = poller;
  });

  console.log(termPoller.term);

  if(termPoller) {
    termPoller.getSeatStats(req.params.crn, function(crn, result) {
      if(result.hasOwnProperty('remaining')) {
        res.send({verification_status:1})
      } else{
        res.send({verification_status:0})
      }
    });
  } else{
    res.send({verification_status:0})
  }
});

app.get('/sign_up', function(req, res) {
  //pass param user: req.session.username
  res.render('sign_up',{title:"Sign Up"});
});

//create an account and send out an email verification link
app.post('/create_account', function(req, res) {
  // myMongoController.createUser("jo@jo.com", "password", "uuid");
  var post = req.body;
  strip_whitespace_from_obj(post);

  var email = post.email,
    password = post.password,
    password_conf = post.password_conf;

  if(password != password_conf) {
    req.session.danger_flash = "Passwords did not match!";
    res.redirect('back');
  } else if(password.length < 6) {
    req.session.danger_flash = "Password must be at least 6 characters in length";
    res.redirect('back');    
  }
  else if(!isEmail(email)) {
    req.session.danger_flash = "Invalid email format!";
    res.redirect('back');
  }
  else{ // valid credentials
    myMongoController.userAccessor(email, function(user_arr) {
      if(user_arr.length > 0 && user_arr[0].activated) {
        req.session.danger_flash = "That e-mail address has already been taken"
        res.redirect('back');
      } else{
        if(user_arr.length > 0 && !user_arr[0].activated){
          user_arr[0].remove();
        }

        var uuid=generateUUID(),
          emailLink = generateEmailVerificationURL(email, uuid);

        myMongoController.createUser(email, password, uuid);
        myMailer.sendEmailVerification(email, emailLink);

        req.session.success_flash = 'You have successfully signed up, now check your e-mail and activate your account before you can log in.';
        res.redirect('/');
      }
    });
  }
});

//endpoint used to confirm validation of an email account
app.get('/verifyEmail', function(req, res) {
  var email = req.query.email,
      uuid = req.query.uuid;

  myMongoController.userAccessor(email, function(user_arr) {
    var user = user_arr[0];

    if(user && user.uuid == uuid) {
      if(user.activated == true) {
        req.session.warning_flash = "Your account has already been activated"
        res.redirect('/');
        return
      }
      user.activated = true;
      user.save();
      req.session.success_flash = "Account activated!"
      res.redirect('/');
    } else{
      req.session.danger_flash = "Account activation failed"
      res.redirect('/');
    }
  });
});

app.get('/log_in', function(req, res) {
  res.render('login',{title:"Login"});
});

//endpoint to authenticate a user
app.post('/login_auth', function(req, res) {
  var user = req.body.email;
  var pass = req.body.password;

  myMongoController.authenticate(user, pass, function(authRes, foundUser) {
    if(authRes == true) {
      if(foundUser.activated == false) {
        req.session.warning_flash = "You need to activate your account from your e-mail before you can log in"
        res.send({redirect: '/log_in'});
      } else{
        req.session.username = user;
        req.session.success_flash = "You have successfully logged in"

        res.send({redirect: '/'});        
      }

    } else{
      res.set('Content-Type', 'text/plain');
      res.send(authRes);
    }
  });
});

app.get('/logout', checkAuth, function(req, res) {
  req.session.destroy();
  res.redirect('/');
});

app.get('/my_account', checkAuth, function(req, res) {
  var username = req.session.username;

  myMongoController.userAccessor(username, function(user_arr) {
    res.render('settings', {user:user_arr[0]});
  });
});

//endpoint to change a password from account settings.
app.post('/change_password', checkAuth, function(req, res) {
  var post = req.body,
      password = post.password,
      password_conf = post.password_conf;

  strip_whitespace_from_obj(post);

  if(password != password_conf) {
    req.session.danger_flash = "Passwords did not match!";
    res.redirect('back');
  } else if(password.length < 6) {
    req.session.danger_flash = "Password must be at least 6 characters in length";
    res.redirect('back');    
  } else{ //success
    myMongoController.changePassword(req.session.username, password);
    req.session.success_flash = "Password changed successfully"
    res.redirect('back');
  }
});

//send out a forgotten password link
app.post('/request_pass_change', function(req, res) {
  var email = req.body.email

  myMongoController.userAccessor(email, function(user_arr) {
    var uuid=generateUUID(),
      emailLink = generateEmailPassChangeURL(email, uuid), 
      user = user_arr[0];

    if(user) {
      user.uuid = uuid;
      user.save();

      myMailer.sendPassChangeVerification(email, emailLink);

      res.send("success");      
    } else{
      res.send("failure");
    }
    
  });
});

//render change password form ONLY if the email and UUID from the URL match a user in the DB
app.get('/verify_pass_change', function(req, res) {
  var email = req.query.email,
      uuid = req.query.uuid;

  myMongoController.userAccessor(email, function(user_arr) {
    var user = user_arr[0];

    if(user && user.uuid == uuid) {
      req.session.uuid = uuid;
      res.render('change_password', {email: email});
    } else{
      req.session.danger_flash = "Invalid change password link";
      res.redirect('/');
    }
  });
});

// endpoint submitted to from 'change_password' form;
// validates password and ONLY accepts password change if the session UUID matches the UUID of user being reset
// this way, we confirm the user in the current session clicked on the verification link 
// (since the verification link route sets session UUID), and it wasn't just some random guy submitting a 
// POST request to our endpoint with email and password params to change
app.post('/change_forgotten_password', function(req, res) {
  var post = req.body,
      password = post.password,
      password_conf = post.password_conf,
      email = post.email;

  strip_whitespace_from_obj(post);

  if(password != password_conf) {
    req.session.danger_flash = "Passwords did not match!";
    res.redirect('back');
  } else if(password.length < 6) {
    req.session.danger_flash = "Password must be at least 6 characters in length";
    res.redirect('back');    
  } else{
    myMongoController.userAccessor(email, function(user_arr) {
      var user = user_arr[0];

      if(user && (user.uuid == req.session.uuid)) {
        user_arr[0].uuid = generateUUID(); //so that the old link doesn't work anymore
        user_arr[0].save();
        myMongoController.changePassword(email, password);
        req.session.success_flash = "Password changed successfully"
        res.redirect('/');
      } else{
        req.session.danger_flash = "Bad token.";
        res.redirect('/');
      }
    });
  }
});

//display a user's current requests
app.get('/my_requests', checkAuth, function(req, res) {
  myMongoController.userAccessor(req.session.username, function(user_arr) {
    var user = user_arr[0],
        reg_reqs,
        sms_reqs,
        auto_reqs;

    find_reqs(user.reg_reqs, myMongoController.Request, function(result) {
      reg_reqs = result;

      find_reqs(user.sms_reqs, myMongoController.smsRequest, function(result) {
        sms_reqs = result;
        
        find_reqs(user.auto_reqs, myMongoController.autoRegReq, function(result) {
          auto_reqs = result;

          format_terms(reg_reqs, sms_reqs, auto_reqs);

          res.render('my_requests', {
            sms_reqs: sms_reqs,
            reg_reqs: reg_reqs,
            auto_reqs: auto_reqs
          });
        });
      });
    });

    //the for-each are blocking, therefore no async issues
    function format_terms(reg_arr, sms_arr, auto_arr) {
      reg_arr.forEach(function(e, i, a) {
        if(e) a[i].term = format_watch_req(e.term);
      });

      sms_arr.forEach(function(e, i, a) {
        if(e) {
          a[i].term = format_watch_req(e.term);
          a[i].gatewayedNumber = e.gatewayedNumber.replace(/@.+/,'');          
        }
      });

      auto_arr.forEach(function(e, i, a) {
        if(e) a[i].term = format_auto_req(e.term);
      });
    }

    function find_reqs(collection, model, next) {
      var result = [],
          collection = collection,
          model = model,
          requests_remaining = collection.length;

      if( requests_remaining > 0) {
        collection.forEach(function(id) {
          model.findById(id, function(err, doc) {
            //Disregard null requests from user's request collection.
            if(doc) result.push(doc);

            requests_remaining--;
            if(requests_remaining == 0) { //only the last executed async call will meet this condition.
              next(result);
            }
          });          
        });
      } else{
        next(result);
      }
    }

  });
});


//endpoint that handles request cancellations
app.get('/cancel_req/:type/:id', checkAuth, function(req, res) {
  strip_whitespace_from_obj(req.params);

  var id = req.params.id,
      type = req.params.type,
      username = req.session.username;

  switch(type) {
    case "EMAIL":
      myMongoController.user.update({email:username}, //initial query 
        {$pull:{reg_reqs: new ObjectId(id)}}, //array pull query
        function(err,data) {} //REQUIRED callback..
      );

      myMongoController.Request.findByIdAndRemove(id, cancellation_redirect);
      break;
    case "SMS":
      myMongoController.user.update({email:username}, //initial query 
        {$pull:{sms_reqs: new ObjectId(id)}}, //array pull query
        function(err,data) {} //REQUIRED callback..
      );

      myMongoController.smsRequest.findByIdAndRemove(id, cancellation_redirect);
      break;
    case "AUTOMATED":
      myMongoController.user.update({email:username}, //initial query 
        {$pull:{auto_reqs: new ObjectId(id)}}, //array pull query
        function(err,data) {} //REQUIRED callback..
      );
  
      myMongoController.autoRegReq.findByIdAndRemove(id, cancellation_redirect);
      break;
    default:
      console.log("Cancellation error... No type matched.");
  }

  function cancellation_redirect() {
    req.session.success_flash = "Request successfully cancelled";
    res.redirect('back');
  }
});



//*WEBSOCKET HANDLING

// io.disable('heartbeats');
//io.set('transports', ['xhr-polling']);

io.sockets.on('connection', socketHandler);

function socketHandler(socket) {
  socket.emit('message', {message:'WebSocket connection established; Welcome to the chat!'});

  socket.on('sendMessage', function(data) {
    io.sockets.emit('message', data);
  });

  socket.on('contactReq', function(data) {
    myMailer.contactMailJob(data.email, data.name, data.message);
  })
}

//figure out what terms are open presently and initalize pollers for them.
function initPollers() {
  var pathComponents= ['/pls/bprod/bwckschd.p_disp_detail_sched?term_in=','4digityear','2digitmonth','&crn_in='];

  initSpringPoller(pathComponents);
  initSummerPoller(pathComponents);
  initFallPoller(pathComponents);

  current_pollers = { spring: springPoller, 
                      summer: summerPoller, 
                      fall: fallPoller };

  //hibernation months, accept or process no requests,
  //no labels for term selection either
  if( !getNumPollers() ) {
    rejectRequests = true;
  }else{
    rejectRequests = false;
  }
}

//spring registration poller
function initSpringPoller(pathComponents) {
  var d = new Date();
      month = d.getMonth(),
      year = (month == 0 ? d.getFullYear() : d.getFullYear() + 1), 
      pathComponents[1] = year;

  if( isSpring(month) ) {
    springTerm = 'spring' + year.toString();
    pathComponents[2] = '02';
    var springBasePath = pathComponents.join('');
    springPoller = new Poller(myMongoController, myMailer, springBasePath, springTerm, myDispatcher);
  }else {
    springPoller = springTerm = null;
  }
}

function initSummerPoller(pathComponents) {
  var d = new Date();
      month = d.getMonth(),
      year = d.getFullYear(),
      pathComponents[1] = year;

  if ( isSummer(month) ) {
    summerTerm = 'summer' + year.toString();
    pathComponents[2] = '05';
    var summerBasePath = pathComponents.join('');
    summerPoller = new Poller(myMongoController, myMailer, summerBasePath, summerTerm, myDispatcher);
  }else {
    summerTerm = summerPoller = null;    
  }
}

function initFallPoller(pathComponents) {
  var d = new Date();
      month = d.getMonth(),
      year = d.getFullYear(),
      pathComponents[1] = year;

  if ( isFall(month) ) {
    fallTerm = 'fall' + year.toString();
    pathComponents[2] = '08';
    var fallBasePath = pathComponents.join('');
    fallPoller = new Poller(myMongoController, myMailer, fallBasePath, fallTerm, myDispatcher);
  }else {
    fallTerm = fallPoller = null;
  }
}

function isSpring(month) {
  return month >= 9 || month <= 0;
}

function isFall(month) {
  return month >= 2 && month <= 8;
}

function isSummer(month) {
  return month >= 2 && month <= 5;
}

function getNumPollers() {
  return getActivePollers().length;
}

//register partials
function registerPartials() {
  var partials_path = "./views/partials",
      partial_files = fs.readdirSync(partials_path);

  partial_files.forEach(function(partial) {
    var matches = /^([^.]+).hbs.html$/.exec(partial);
    if (!matches) { return };
    var name = matches[1];

    var partial = fs.readFileSync(partials_path + "/" + partial, 'utf8');
    hbs.registerPartial(name, partial);
  });
}

//get all pollers for current school-terms.
function getActivePollers() {
  var result = [];

  for (var key in current_pollers) {
    if (current_pollers.hasOwnProperty(key)) {
      if(current_pollers[key]) {
        result.push(current_pollers[key]);
      }
    }
  }

  return result;
}

function checkAuth(req, res, next) {
  if (!req.session.username) {
    req.session.danger_flash = "You must be logged in to perform that action";
    res.redirect('/');
  } else {
    next();
  }
}

//periodically access unused sessions so that they are expired by Express.
function sessionCleanup() {
  sessionStore.all(function(err, sessions) {
    for (var i = 0; i < sessions.length; i++) {
      sessionStore.get(sessions[i], function() {} );
    }
  });
}

function generateUUID() {
  return   'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

function generateEmailVerificationURL(email, uuid) {
  return hostName+"/verifyEmail?email=" +
  email + "&uuid=" + uuid;
}

function generateEmailPassChangeURL(email, uuid) {
  return hostName+"/verify_pass_change?email=" +
  email + "&uuid=" + uuid;
}

//Semi-alias for create createLabel method, although different implementation..
function format_watch_req(term) {
  var year_idx = term.indexOf(2),
      season = term.slice(0,year_idx),
      year = term.slice(year_idx),

  capitalizedSeason = season.charAt(0).toUpperCase() + season.slice(1);
  return capitalizedSeason + " " + year;
}

function format_auto_req(term) {
  return term.replace('-', ' ');
}

//create labels for front-end term selectors
function createLabel(term) {
  var length = term.length,
      year = term.slice(length-4,length),
      season = term.slice(0,length-4);
  
  season = capitalizeFirstLetter(season);
  return season + " " + year;
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function isEmail(email) {
  var regex = /^([a-zA-Z0-9_.+-])+\@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,4})+$/;
  return regex.test(email);
}

function strip_whitespace(input) {
  // return input.replace(/\s+/g, "");
  return input
}

function strip_whitespace_from_obj(input_obj) {
  return;
  for (var key in input_obj) {
    input_obj[key] = strip_whitespace(input_obj[key]);
  }
}

//*SCHEDULED JOBS

myMongoController.cleanExpiredReqs();

//Daily Tasks
setInterval(function() {
  initPollers();
  myMongoController.cleanExpiredReqs();
  sessionCleanup();
}, millisInDay);

//polling job
setInterval(function() {
  for (var key in current_pollers) {
    if (current_pollers.hasOwnProperty(key)) {
      //alert(key + " -> " + p[key]);
      if(current_pollers[key]) current_pollers[key].pollAllSeats();
    }
  }
}, 2*millisInMinute); //*millisInMinute

//refresh fulfillment stats
setInterval(function() {
  myMongoController.getFulfillmentStats(function(stats) {
    fulfillment_stats = stats;
  });
}, 5*millisInMinute);

//Uncomment to re-run the crn scan on the term
// myTermManager.set_probed('201502', false);







