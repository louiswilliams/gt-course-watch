var mongoose = require('mongoose'),
    Schema = mongoose.Schema,
    bcrypt = require('bcryptjs');

//
// MONGO SETUP
//

function MongoController() {
  _this = this;

  this._myDB = mongoose.connection;
  this.db_open = false;

  //investigate why closure with _this wont work..
  this.requestSchema = mongoose.Schema({
    crn: String,
    email: String,
    term: String
  });

  this.smsRequestSchema = mongoose.Schema({
    crn: String,
    email: String,
    gatewayedNumber: String,
    term: String
  });

  this.autoRegReqSchema = mongoose.Schema({
    crn: String,
    email: String,
    term: String,
    buzzport_id: String,
    buzzport_pass: String,
    beingProcessed: String
  });

  this.confirmationStatSchema = mongoose.Schema({
    reg_reqs: Number,
    sms_reqs: Number,
    auto_reqs: Number
  });

  this.successStatSchema = mongoose.Schema({
    reg_reqs: Number,
    sms_reqs: Number,
    auto_reqs: Number
  });

  this.userSchema = mongoose.Schema({
    email: String,
    password_hash: String,
    uuid: String,
    activated: Boolean,
    reg_reqs: [],
    sms_reqs: [],
    auto_reqs: []
  });

  this.reqArchiveSchema = mongoose.Schema({
    type: String, // REG, SMS
    email: String,
    term: String,
    crn: String,
    gatewayedNumber: String,
    timestamp: Date
  });

  this.Request = mongoose.model('Request', this.requestSchema);
  this.smsRequest = mongoose.model('smsRequest', this.smsRequestSchema);
  this.autoRegReq = mongoose.model('autoRegReq', this.autoRegReqSchema);
  this.confirmationStat = mongoose.model('confirmationStat', this.confirmationStatSchema);
  this.successStat = mongoose.model('successStat', this.successStatSchema);
  this.user = mongoose.model('user', this.userSchema);
  this.req_archive = mongoose.model('req_archive', this.reqArchiveSchema)
}

MongoController.prototype.connect = function(connectionURL, callback) {

  mongoose.connect(connectionURL);
  mongoose.connection.on('error', console.error.bind(console, 'connection error'));
  mongoose.connection.on('open', function() {
    console.log('db successfully connected');
    _this.db_open = true;
    callback(mongoose.connection)
  });
}

MongoController.prototype.userAccessor = function (email, f) {
  this.user.find({email:email},function(err, foundUser) {
    if (err) return console.log('find user error: ' + err);
    if(!foundUser) return console.log('could not find user');
    f(foundUser);
  });
}


MongoController.prototype.getFulfillmentStats = function(func) {
  _this = this;

  if(!_this.db_open) {
    console.log("DB not open");
  }

  _this.successStat.find(function(err1, successes){
    _this.confirmationStat.find(function(err2, confirmations){
      if(err1 || err2) {
        ret = {
          fulfilled: 0,
          total: 0,
          rate: 0
        };
      }else{
        var f = successes.length,
            c = confirmations.length;

        ret = {
          fulfilled: f,
          total: c,
          rate: ((f/c) * 100).toFixed(2)
        };
      }

      func(ret);
    });
  });
};

MongoController.prototype.addToArchive = function(type, email, term, crn, gate_number) {
    var infostat = new this.req_archive({
      type: type,
      email: email,
      term: term,
      crn: crn,
      gatewayedNumber: gate_number,
      timestamp: new Date()
    });

    infostat.save(function(err, doc) {
      if(err) console.log('save error: ' + err);
    });
}

MongoController.prototype.createUser = function (email, password, uuid) {
  var _this = this;

  bcrypt.genSalt(10, function(err, salt) {
    bcrypt.hash(password, salt, function(err, hash) {
        // Store hash in your password DB.
      var newUser = new _this.user({
        email: email,
        password_hash: hash,
        uuid: uuid,
        activated: false
      });

      newUser.save(function(err, doc) {
        if(err) console.log('save error: ' + err);
      });
    });
  });
}

MongoController.prototype.authenticate = function (email, password, next) {

  this.user.findOne({email:email}, function(err, foundUser) {
    if(err) return console.log("find user error: " + err);
    
    if(!foundUser) next(false, null);
    else{
      bcrypt.compare(password, foundUser.password_hash, function(err, authRes) {
        if (err) return console.log('bcrypt compare error: ' + err);

        //authRes == true on match
        next(authRes, foundUser);
      });    
    }
  });
}

MongoController.prototype.changePassword = function(email, password) {
  this.user.findOne({email:email}, function(err, user) {
    if(err) return console.log("find user error: " + err);

    if(!user) return
    else{
      bcrypt.genSalt(10, function(err, salt) {
          bcrypt.hash(password, salt, function(err, hash) {
              // Store hash in your password DB.
              user.password_hash = hash;
              user.save();
          });
      });
    }
  });
}

//STANDARD REQUEST
MongoController.prototype.createRequest = function (crnInput, emailInput, termInput, next) {
  var newRequest = new this.Request({crn:crnInput,email:emailInput,term:termInput});

  newRequest.save(function(err, doc) {
    if(err) {
      console.log('save error:' + err);
    } else{
      next(doc);
    }
  });
}

//SMS REQUEST (same as standard with added sms capability)
MongoController.prototype.createSMSRequest = function createSMSRequest(crnInput, emailInput, gatewayedInput, termInput, next) {
  var newSMSRequest = new this.smsRequest({crn:crnInput,email:emailInput,
    gatewayedNumber:gatewayedInput, term:termInput});
  
  newSMSRequest.save(function(err, doc) {
    if(err) {
      console.log('save error:' + err);
    } else{
      next(doc);
    }
  });
}

MongoController.prototype.createAutoRegReq = function(iCrn, iEmail, iTerm, iBuzzId, iBuzzPass, next) {
  var newAutoRegReq = new this.autoRegReq({
      crn: iCrn,
      email: iEmail,
      term: iTerm,
      buzzport_id: iBuzzId,
      buzzport_pass: iBuzzPass,
      beingProcessed: "false"
    });

  newAutoRegReq.save(function(err, doc) {
    if(err) {
      console.log(err);
    } else{
      next(doc);
    }
  });
}

MongoController.prototype.createConfirmationStat = function (regular, sms, auto) {
  var newStat = new this.confirmationStat({reg_reqs:regular,sms_reqs:sms,auto_reqs:auto});
  newStat.save(function(err, doc) {
    if(err) {
      console.log('save error:' + err);
    }
  });
}

MongoController.prototype.createSuccessStat = function (regular, sms, auto) {
  var newStat = new this.successStat({reg_reqs:regular,sms_reqs:sms,auto_reqs:auto});
  newStat.save(function(err, doc) {
    if(err) {
      console.log('save error:' + err);
    }
  });
}

//delete reqs from last yr.
MongoController.prototype.cleanExpiredReqs = function() {
  var d = new Date(),
    month = d.getMonth(),
    date_of_month = d.getDate(),
    yr = d.getFullYear(),
    _this = this;
 

  if(month >= 1 && month <= 8) {
    //clean spring for the year on February/1 - September/31
    removeTerm('spring' + yr);
  }

  if(month >= 6 || month <= 1) {
    //clean up summer for the year on July/1 - February/31
    if(month <= 1) {
      removeTerm('summer' + (yr-1));
    } else {
      removeTerm('summer' + yr);
    }
  } 

  if(month >= 9 || month <= 1) {
    //clean up fall for the year on October/1 - February/31
    if(month <= 1) {
      removeTerm('fall' + (yr-1));
    } else {
      removeTerm('fall' + yr);
    }
  }

  function removeTerm(removal_term) {
    _this.Request.find( { term: removal_term }, remover_helper );
    _this.smsRequest.find( { term: removal_term }, remover_helper );    
  }

  function remover_helper(err, foundReqs) {
    if(err) console.log(err);

    foundReqs.forEach(function(e) {
      e.remove();
    });
  }
}

module.exports = MongoController;
