import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
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
        fromPort: 80,
        toPort: 80,
        protocol: "tcp",
        cidrBlocks: [destinationCidrBlock],
    },
    {
        fromPort: 443,
        toPort: 443,
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

// const _default = new aws.rds.Instance("default", {
//     allocatedStorage: 10,
//     dbName: "mydb",
//     engine: "mysql",
//     engineVersion: "5.7",
//     instanceClass: "db.t3.medium",
//     parameterGroupName: "default.mysql5.7",
//     password: "Password",
//     skipFinalSnapshot: true,
//     username: "admin",
// });

// const cidrBlock = pulumi.output(applicationSecurityGroup.egress).apply(egress => {
//     if (egress && egress[0] && egress[0].cidrBlocks) {
//         return egress[0].cidrBlocks;
//     }
//     return [];
// });


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


const devUserDataJson = pulumi.interpolate`#!/bin/bash
# Define the file path
devJsonFile="/home/admin/webapp1/config/config.json";

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
echo '    "dialectOptions": {' >> "$devJsonFile"
echo '      "ssl": {' >> "$devJsonFile"
echo '        "require": true,' >> "$devJsonFile"
echo '        "rejectUnauthorized": false' >> "$devJsonFile"
echo '      }' >> "$devJsonFile"
echo '    }' >> "$devJsonFile"
echo '  }' >> "$devJsonFile"
echo "}" >> "$devJsonFile"
`;

console.log(devUserDataJson);


const instance = new aws.ec2.Instance("myEc2Instance", {
    ami: amiId, 
    instanceType: "t3.medium", 
    vpcSecurityGroupIds: [applicationSecurityGroup.id], 
    subnetId: publicSubnets[0].id, 
    rootBlockDevice: {
        volumeSize: 25,
        volumeType: "gp2",
        deleteOnTermination: true,
    },

    userData: devUserDataJson,
    disableApiTermination: false,
    keyName: keyPairName,
    tags: { Name: "MyEC2Instance" },

});

export const rdsInstanceId = rdsInstance.id;

export const ec2InstanceId = instance.id;
