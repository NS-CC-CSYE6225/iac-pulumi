import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as gcp from "@pulumi/gcp";
import * as fs from "fs";
// pulumi import aws:rds/instance:Instance default mydb-rds-instance

const config = new pulumi.Config();

const baseCidrBlock = config.require("baseCidrBlock");
const amiId = config.require("amiId");
const destinationCidrBlock = config.require("destinationCidrBlock");

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: baseCidrBlock,
});

const availabilityZones = pulumi.output(aws.getAvailabilityZones({
    state: "available"
})).apply(az => az.names.slice(0, 3));

const NewSubnetMask = (vpcMask: number, numSubnets: number): number => {
    const bitsNeeded = Math.ceil(Math.log2(numSubnets));
    return vpcMask + bitsNeeded;
};

const convertfromIp = (ip: string): number => {
    const octets = ip.split('.').map(Number);
    return (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
};

const coverttoIp = (int: number): string => {
    return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
};

const SubnetCidrBlocks = (baseCidrBlock: string, numSubnets: number): string[] => {
    const [baseIp, vpcMask] = baseCidrBlock.split('/');
    const newSubnetMask = NewSubnetMask(Number(vpcMask), numSubnets);
    const subnetSize = Math.pow(2, 32 - newSubnetMask);
    const subnetCidrBlocks = [];
    for (let i = 0; i < numSubnets; i++) {
        const subnetIpInt = convertfromIp(baseIp) + i * subnetSize;
        const subnetIp = coverttoIp(subnetIpInt);
        subnetCidrBlocks.push(`${subnetIp}/${newSubnetMask}`);
    }
    return subnetCidrBlocks;
};

const subnetCidrBlocks = SubnetCidrBlocks(baseCidrBlock, 6);

const publicSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`public-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index],
            availabilityZone: az,
            mapPublicIpOnLaunch: true,
            tags: { Name: `public-subnet-${az}` }
        });
        return subnet;
    })
);

const privateSubnets = availabilityZones.apply(azs =>
    azs.map((az, index) => {
        const subnet = new aws.ec2.Subnet(`private-subnet-${az}`, {
            vpcId: vpc.id,
            cidrBlock: subnetCidrBlocks[index + 3],
            availabilityZone: az,
            tags: { Name: `private-subnet-${az}` }
        });
        return subnet;
    })
);

const internetGateway = new aws.ec2.InternetGateway("my-internet-gateway", {
    vpcId: vpc.id,
    tags: { Name: "my-internet-gateway" },
});

const publicRouteTable = new aws.ec2.RouteTable("public-route-table", {
    vpcId: vpc.id,
    tags: { Name: "public-route-table" },
});

publicSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`public-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: publicRouteTable.id,
        });
    });
});

const privateRouteTable = new aws.ec2.RouteTable("private-route-table", {
    vpcId: vpc.id,
    tags: { Name: "private-route-table" },
});

privateSubnets.apply(subnets => {
    subnets.forEach((subnet, index) => {
        new aws.ec2.RouteTableAssociation(`private-subnet-rt-association-${index}`, {
            subnetId: subnet.id,
            routeTableId: privateRouteTable.id,
        });
    });
});

new aws.ec2.Route("public-route", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: destinationCidrBlock,
    gatewayId: internetGateway.id,
});

export const vpcId = vpc.id;
export const publicSubnetIds = publicSubnets.apply(subnets => subnets.map(subnet => subnet.id));
export const privateSubnetIds = privateSubnets.apply(subnets => subnets.map(subnet => subnet.id));

export const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup("loadbalancer-security-group", {
    description: "Security group for Load Balancer",
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
    tags: { Name: "Csye6255-loadbalancer-security-group" },
});

const applicationSecurityGroup = new aws.ec2.SecurityGroup("applicationSecurityGroup", {
    vpcId: vpc.id,
    description: "Web application instances Security group",
});


const ingressRules = [
    {
        fromPort: 22,
        toPort: 22,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock],
    },

    {
        fromPort: 8080,
        toPort: 8080,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock],
    },
];

ingressRules.forEach((rule, index) => {
    new aws.ec2.SecurityGroupRule(`appSecurityGroupRule${index}`, {
        securityGroupId: applicationSecurityGroup.id,
        type: "ingress",
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrBlocks: rule.cidrBlocks,
    });
});

let rawKeyContent: string;
try {
    rawKeyContent = fs.readFileSync("/Users/aravindsankars/.ssh/myawskey.pub", 'utf8').trim();
} catch (error) {
    pulumi.log.error("Error reading the key file.");
    throw error;
}

const keyParts = rawKeyContent.split(" ");
const publicKeyContent = keyParts.length > 1 ? `${keyParts[0]} ${keyParts[1]}` : rawKeyContent;

const keyPair = new aws.ec2.KeyPair("mykeypair", {
    publicKey: publicKeyContent,
});

const keyPairName = keyPair.id.apply(id => id);


const dbSecurityGroup = new aws.ec2.SecurityGroup("dbSecurityGroup", {
    vpcId: vpc.id,
    description: "RDS Security Group",
    tags: { Name: "DB Security Group" },
});

// Ingress Rule to Allow MySQL (Port 3306) Access from Application Security Group
new aws.ec2.SecurityGroupRule("rdsIngressRule", {
    securityGroupId: dbSecurityGroup.id,
    type: "ingress",
    fromPort: 3306,
    toPort: 3306,
    protocol: "tcp",
    sourceSecurityGroupId: applicationSecurityGroup.id,
});

const egressRules = [
    {
        protocol: "-1",
        fromPort: 0,
        toPort: 0,
        cidrBlocks: ["0.0.0.0/0"],
    },
];

egressRules.forEach((rule, index) => {
    new aws.ec2.SecurityGroupRule(`appSecurityGroupEgressRule${index}`, {
        securityGroupId: applicationSecurityGroup.id,
        type: "egress",
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        protocol: rule.protocol,
        cidrBlocks: rule.cidrBlocks,
    });
});


const dbParameterGroup = new aws.rds.ParameterGroup("db-parameter-group", {
    family: "mysql8.0",
    description: " Parameter group for db"
});

// Create a subnet group for RDS
const dbSubnetGroup = new aws.rds.SubnetGroup("db-subnet-group", {
    subnetIds: privateSubnetIds,
});

const rdsInstance = new aws.rds.Instance("rds-instance", {
    allocatedStorage: 20,
    engine: "mysql",
    instanceClass: "db.t3.medium",
    multiAz: false,
    name: "csye6225",
    username: "csye6225",
    password: "password",
    parameterGroupName: dbParameterGroup.name, 
    skipFinalSnapshot: true,
    publiclyAccessible: false,
    dbSubnetGroupName: dbSubnetGroup.name,
    vpcSecurityGroupIds: [dbSecurityGroup.id],
});

// Define the IAM role with CloudWatchAgentServer policy
const roleIAM = new aws.iam.Role("CloudWatch_Dev", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
});


// Create a Google Cloud Storage bucket
//
const bucket = new gcp.storage.Bucket("webapp-aravind", {
    location: "US",
});

// Create a Google Service Account
//
const serviceAccount = new gcp.serviceaccount.Account("csye6225-gcp-aravind", {
    accountId: "csye6225-gcp-aravind",
    displayName: "csye6225-gcp-aravind",
});

//
const defaultProject = config.require("project"); 

// Assign necessary roles to the service account
//
const storageAdminBinding = new gcp.projects.IAMBinding("storage-admin-binding", {
    project: defaultProject,
    role: "roles/storage.admin",
    members: [serviceAccount.email.apply(email => `serviceAccount:${email}`)],
});

// Create Access Keys for the Service Account
//
const serviceAccountKey = new gcp.serviceaccount.Key("csye6225-gcp-aravind-account-key", {
    serviceAccountId: serviceAccount.name,
    publicKeyType: "TYPE_X509_PEM_FILE",
});

// Export the bucket name and service account key
//
export const bucketName = bucket.name;
export const serviceAccountKeyEncoded = pulumi.secret(
    serviceAccountKey.privateKey.apply(key => Buffer.from(key, 'base64').toString('utf-8'))
);


// Attach the CloudWatchAgentServer policy to the role
const policyAttachment = new aws.iam.RolePolicyAttachment("CloudWatchAgentServerPolicyAttachment", {
    role: roleIAM.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

// Create an SNS Topic
//
const snsTopic = new aws.sns.Topic("sns-topic", {
    displayName: "SNS-Topic", 
});

// Export the SNS topic ARN
//
export const snsTopicArn = snsTopic.arn;

const snsEC2FullAccessPolicyAttachment = new aws.iam.RolePolicyAttachment("snsEC2FullAccessPolicyAttachment", {
    role: roleIAM.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
});

const instanceProfile = new aws.iam.InstanceProfile("ec2InstanceProfile", {
    role: roleIAM.name,
});

// Attach policy to EC2 SNS role
//
const ec2SNSPolicy = new aws.iam.RolePolicy("EC2SNSTopicPolicy", {
    role: roleIAM.name, // Ensure ec2Role is defined
    policy: snsTopic.arn.apply((arn) => pulumi.interpolate`{
        "Version": "2012-10-17",
        "Statement": [
            {
                "Effect": "Allow",
                "Action": "sns:Publish",
                "Resource": "${arn}"
            }
        ]
    }`),
});

// Create an IAM role for the Lambda function
//
const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: pulumi.output({
        Version: "2012-10-17",
        Statement: [{
            Action: "sts:AssumeRole",
            Effect: "Allow",
            Principal: {
                Service: "lambda.amazonaws.com",
            },
        }],
    }),
});

const lambdaPolicy = new aws.iam.Policy("lambdaPolicy", {
    policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: [
                    "ses:SendEmail",
                    "ses:SendRawEmail"
                ],
                Resource: "*" // Specify your SES resource ARN if you want to restrict to specific resources
            },
            {
                Effect: "Allow",
                Action: [
                    "dynamodb:GetItem",
                    "dynamodb:PutItem",
                    "dynamodb:UpdateItem",
                    "dynamodb:DeleteItem",
                    "dynamodb:Scan",
                    "dynamodb:Query"
                ],
                Resource: "*" // Replace with your DynamoDB table ARN
            },
            {
                Effect: "Allow",
                Action: [
                    "sts:AssumeRole"
                ],
                Resource: "*" // Specify the ARN of the GCP service account role here
            }
        ],
    }),
});

const rolePolicyAttachment = new aws.iam.RolePolicyAttachment("rolePolicyAttachment", {
    role: lambdaRole.name,
    policyArn: lambdaPolicy.arn,
});

const snsFullAccessPolicyAttachment = new aws.iam.RolePolicyAttachment("snsFullAccessPolicyAttachment", {
    role: lambdaRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSNSFullAccess",
});

const CloudwatchPolicyAttachment = new aws.iam.RolePolicyAttachment("CloudwatchPolicyAttachment", {
    role: lambdaRole.name,
    policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

//Create DynamoDB instance
//
const table = new aws.dynamodb.Table("email-list-table", {
    attributes: [
        { name: "id", type: "S" }, // Composite primary key (email+timestamp)
        { name: "email", type: "S" },
        { name: "timestamp", type: "S" },
        { name: "status", type: "S" }
    ],
    hashKey: "id",
    billingMode: "PAY_PER_REQUEST",
    globalSecondaryIndexes: [
        {
        name: "EmailIndex",
        hashKey: "email",
        projectionType: "ALL", 
        },
        {
            name: "timestampIndex",
            hashKey: "timestamp",
            projectionType: "ALL", 
        },
        {
            name: "statusIndex",
            hashKey: "status",
            projectionType: "ALL", 
        }
]
});


// Create the Lambda function
//
const lambdaFunction = new aws.lambda.Function("lambdaFunction", {
    name: 'my-lambda-funtion',
    runtime: aws.lambda.Runtime.NodeJS18dX,
    handler: "index.handler",
    code: new pulumi.asset.FileArchive(config.require("fileArchive")),
    role: lambdaRole.arn,

    environment: {
        variables: {
            GCP_SERVICE_ACCOUNT_KEY: serviceAccountKeyEncoded,
            BUCKET_NAME: bucketName,
            TABLE_NAME: table.name,
            MAILGUN_API_KEY: config.require("mailgunApiKey"),
            MAILGUN_DOMAIN: config.require("mailgunDomain"),        
        },
    },
});


    // Add SNS trigger to Lambda function
    //
const lambdaSnsPermission = new aws.lambda.Permission(
    "lambdaSnsPermission",
    {
      action: "lambda:InvokeFunction",
      function: lambdaFunction.arn,
      principal: "sns.amazonaws.com",
      sourceArn: snsTopic.arn,
    }
  );

// Subscribe the Lambda function to the SNS topic
//
const snsSubscription = new aws.sns.TopicSubscription("snsSubscription", {
    protocol: "lambda",
    endpoint: lambdaFunction.arn,
    topic: snsTopic.arn,
});

const devUserDataJson = pulumi.interpolate`#!/bin/bash
# Define the file path
devJsonFile="/opt/csye6225/webapp1/config/config.json";

# Wipe out existing data if the file exists
if [ -f "$devJsonFile" ]; then
    > "$devJsonFile"  # This will truncate the file, effectively wiping out existing data
fi

# Create the development section
echo "{" > "$devJsonFile"
echo '  "development": {' >> "$devJsonFile"
echo '    "host": "${rdsInstance.address}",' >> "$devJsonFile"
echo '    "username": "${rdsInstance.username}",' >> "$devJsonFile"
echo '    "password": "${rdsInstance.password}",' >> "$devJsonFile"
echo '    "database": "${rdsInstance.dbName}",' >> "$devJsonFile"
echo '    "dialect": "mysql",' >> "$devJsonFile"
echo '    "port": 3306,' >> "$devJsonFile"
echo '    "port": 5432,' >> "$devJsonFile"
echo '    "TOPIC_ARN": "${snsTopicArn}",' >> "$devJsonFile"
echo '    "dialectOptions": {' >> "$devJsonFile"
echo '      "ssl": {' >> "$devJsonFile"
echo '        "require": true,' >> "$devJsonFile"
echo '        "rejectUnauthorized": false' >> "$devJsonFile"
echo '      }' >> "$devJsonFile"
echo '    }' >> "$devJsonFile"
echo '  }' >> "$devJsonFile"
echo "}" >> "$devJsonFile"

# Fetch the latest CloudWatch agent configuration and start the agent
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a start

sudo systemctl start systemd.service

sudo chown -R csye6225:csye6225 /opt/csye6225/webapp1

`;

export const alb = new aws.lb.LoadBalancer("app-lb", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [loadBalancerSecurityGroup.id],
    subnets: publicSubnets.apply(subnets => subnets.map(subnet => subnet.id)),
    enableDeletionProtection: false,
});

const launchTemplate = new aws.ec2.LaunchTemplate("myLaunchTemplate", {
    name: "my-launch-template",
    imageId:amiId,
    description: "My Launch Template",
    blockDeviceMappings: [{
        deviceName: "/dev/xvda",
        ebs: {
            volumeSize: 25,
            volumeType: "gp2",
            deleteOnTermination: 'true',
        },
    }],
    instanceType: "t3.medium",
    keyName: keyPairName,
    networkInterfaces: [{
        deviceIndex: 0,
        associatePublicIpAddress:  'true',
        securityGroups: [applicationSecurityGroup.id],
        subnetId: publicSubnets[0].id,
    }],
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "Csye6255-Aravind",
        },
    }],
    userData:  pulumi.interpolate`${devUserDataJson.apply((s) =>
        Buffer.from(s).toString("base64")
      )}`,
    iamInstanceProfile: {
        name: instanceProfile.name,
    },
    disableApiTermination:false
},{dependsOn: [keyPair,rdsInstance]});

const targetGroup = new aws.alb.TargetGroup("targetGroup",{
    port:8080,
    protocol:'HTTP',
    vpcId:vpc.id,
    targetType:'instance',
    healthCheck:{
      enabled:true,
      path:'/healthz',
      protocol:'HTTP',
      port:'8080',
      timeout:25
  
    }
  })

const listener = new aws.alb.Listener("listener",{
   loadBalancerArn:alb.arn,
   port:80,
   defaultActions:[{
     type:'forward',
     targetGroupArn:targetGroup.arn
   }]
 })


   // Create an Auto Scaling group
const autoScalingGroup = new aws.autoscaling.Group("myAutoScalingGroup", {
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest",
    },
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 1,
    targetGroupArns:[targetGroup.arn],
    vpcZoneIdentifiers: [publicSubnets[0].id,publicSubnets[1].id,publicSubnets[2].id], // Subnet IDs where instances will be launched // Get availability zones
    tags: [{
        key: "Name",
        value: "Csye6255-Aravind",
        propagateAtLaunch: true,
    }],
});

// Define scaling policies
const scaleUpPolicy = new aws.autoscaling.Policy("scaleUpPolicy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    policyType: "SimpleScaling",
    scalingAdjustment: 1,
    cooldown: 60,
});

const scaleDownPolicy = new aws.autoscaling.Policy("scaleDownPolicy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    policyType: "SimpleScaling",
    scalingAdjustment: -1,
    cooldown: 300,
});

// CloudWatch Alert for Scale Up
const scaleUpAlarm = new aws.cloudwatch.MetricAlarm("scaleUpAlarm", {
    comparisonOperator: "GreaterThanOrEqualToThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 5,
    alarmActions: [scaleUpPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

// CloudWatch Alert for Scale Down
const scaleDownAlarm = new aws.cloudwatch.MetricAlarm("scaleDownAlarm", {
    comparisonOperator: "LessThanOrEqualToThreshold",
    evaluationPeriods: 1,
    metricName: "CPUUtilization",
    namespace: "AWS/EC2",
    period: 60,
    statistic: "Average",
    threshold: 3,
    alarmActions: [scaleDownPolicy.arn],
    dimensions: {
        AutoScalingGroupName: autoScalingGroup.name,
    },
});

const hzoneName = config.require("hzoneName");
const hostedZone = aws.route53.getZone({ name: hzoneName }, { async: true });

hostedZone.then(zoneId => { new aws.route53.Record("Record", {
    name: zoneId.name,
    zoneId: zoneId.id,
    type: "A",

    aliases:[
        {
          name:alb.dnsName,
          zoneId:alb.zoneId,
          evaluateTargetHealth:true
        }]
  });
});  

export const rdsInstanceId = rdsInstance.id;

// export const ec2InstanceId = instance.id;
